import { useCallback, useEffect, useRef } from "react";
import type { ShadowApiClient } from "./api/client.ts";
import { ChapterPage } from "./pages/ChapterPage.tsx";
import { ChatPage } from "./pages/ChatPage.tsx";
import { VolumeListPage } from "./pages/VolumeListPage.tsx";
import { VolumeViewPage } from "./pages/VolumeViewPage.tsx";
import { type NavigateOptions, type Route, useHashRoute } from "./routing/useHashRoute.ts";
import { ThemeToggle } from "./theme/ThemeToggle.tsx";

/**
 * The whole app: no domain logic (docs/ARCHITECTURE.md), just routing over
 * one API client and four screens.
 *
 * ## F6 review fix: `ChatPage` is keyed by the route's own session id
 *
 * Before this fix, `ChatPage` was rendered unkeyed — React reuses the same
 * component instance across re-renders at the same JSX position regardless
 * of prop changes, so a URL change from one session's address to a
 * DIFFERENT session's (browser back/forward between two chat URLs, or a
 * future "resume" click, T3.2) left the SAME `ChatPage` instance mounted.
 * `ChatPage`'s own `sessionIdRef`/`followingRef` are captured once, AT
 * MOUNT, by design (`ChatPage.tsx`'s own doc) — so that stale instance kept
 * following the OLD session while the URL, and every fresh send, pointed at
 * the new one: a silent wrong-session write. Keying by `route.sessionId`
 * fixes this the ordinary React way: a key change forces React to tear down
 * the old instance and mount a fresh one, which is exactly "fresh
 * transcript state, a fresh follow subscription for the new id" for free.
 *
 * ## The one transition that must NOT remount
 *
 * `ChatPage`'s own first send mints a session id and replace-navigates from
 * `#/v/:slug/chat` to `#/v/:slug/chat/:sessionId` (`ChatPage.tsx`'s doc) —
 * the id-less mount is still driving its OWN `POST /api/chat` stream
 * directly at that point; remounting mid-render to open a fresh replay
 * would discard the transcript that exact send is still building and race
 * the very rendering already in flight. `replace: true` is used for
 * exactly this ONE transition in the whole app (nowhere else calls it) —
 * `mintedSessionIdRef` remembers the session id minted that way so the key
 * computed below stays `"new"` through it, the same key the id-less mount
 * already had.
 */
export function App({ client }: { readonly client: ShadowApiClient }) {
  const [route, rawNavigate] = useHashRoute();

  const mintedSessionIdRef = useRef<string | undefined>(undefined);

  const navigate = useCallback(
    (next: Route, options?: NavigateOptions) => {
      const isSelfMintedReplace =
        options?.replace === true &&
        next.name === "chat" &&
        route.name === "chat" &&
        route.slug === next.slug &&
        route.sessionId === undefined &&
        next.sessionId !== undefined;
      if (isSelfMintedReplace) {
        mintedSessionIdRef.current = next.sessionId;
      }
      rawNavigate(next, options);
    },
    [route, rawNavigate],
  );

  // Consumes the one-shot exemption the render immediately after it took
  // effect. Mutating a ref never itself triggers a re-render, so this only
  // ever matters the NEXT time `route` genuinely changes — by which point
  // the self-mint has already done its one job (keeping the key at "new"
  // for the render where `route.sessionId` first became defined) and
  // clearing it here can't retroactively change a key already computed.
  useEffect(() => {
    if (
      route.name === "chat" &&
      route.sessionId !== undefined &&
      route.sessionId === mintedSessionIdRef.current
    ) {
      mintedSessionIdRef.current = undefined;
    }
  }, [route]);

  const chatKey =
    route.name === "chat"
      ? route.sessionId !== undefined && route.sessionId === mintedSessionIdRef.current
        ? "new"
        : (route.sessionId ?? "new")
      : undefined;

  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="app-shell__topbar">
        <button
          type="button"
          className="app-shell__brand"
          onClick={() => navigate({ name: "volumes" })}
        >
          Shadow
        </button>
        <ThemeToggle />
      </header>
      <main id="main" className="app-shell__main">
        {route.name === "volumes" && <VolumeListPage client={client} navigate={navigate} />}
        {route.name === "volume" && (
          <VolumeViewPage client={client} slug={route.slug} navigate={navigate} />
        )}
        {route.name === "chat" && (
          <ChatPage
            key={chatKey}
            client={client}
            slug={route.slug}
            sessionId={route.sessionId}
            navigate={navigate}
          />
        )}
        {route.name === "chapter" && (
          <ChapterPage
            client={client}
            slug={route.slug}
            chapterSlug={route.chapter}
            navigate={navigate}
          />
        )}
      </main>
    </div>
  );
}
