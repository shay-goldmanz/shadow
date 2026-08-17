import { useCallback, useEffect, useRef, useState } from "react";
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
 * computed below stays stable through it, the same key the id-less mount
 * already had.
 *
 * ## F3 review fix: a fresh key per id-less visit, not a fixed "new"
 *
 * Every id-less chat mount used to share the literal key "new" — fine for
 * the self-mint transition above (the whole point: same key, no remount),
 * but wrong for the OTHER way a chat route loses its session id: deleting
 * the currently-open session (`SessionList`'s `handleDelete`) navigates to
 * `{chat, slug}` with no `sessionId`. If that delete happened to land while
 * `mintedSessionIdRef` was still holding this exact session's id (the brief
 * window between the self-mint's own render and the `useEffect` below
 * clearing it — probe-confirmed live), the OLD key was already "new" (the
 * self-mint branch) and the NEW key would ALSO be "new" (the id-less-route
 * branch) — no key change, no remount, `ChatPage` keeps running against a
 * `sessionId` the store no longer has a row for: a stale transcript on
 * screen, and the next send POSTs a dead id. `newChatNonce` closes this the
 * ordinary React way: bumped in `navigate` whenever a chat route THAT HAD A
 * SESSION (self-minted or resumed — anything with `route.sessionId !==
 * undefined`) is about to be replaced by an id-less one, so that
 * transition's key always differs from whatever key the session-carrying
 * route was using, remount guaranteed regardless of `mintedSessionIdRef`'s
 * exact state at that instant. Every id-less key below is
 * `new-${newChatNonce}` rather than a bare "new" for the same reason — a
 * stable suffix per "chat session" the nonce hasn't moved past, not a magic
 * constant three different render paths have to agree on by convention.
 * The two existing invariants this app relies on both still hold: the
 * self-mint transition never bumps the nonce (`next.sessionId !==
 * undefined`, so `isLeavingSessionForIdLessChat` below is false for it),
 * and an A→B navigation between two real session ids remounts exactly as
 * before (their keys are the ids themselves, untouched by the nonce).
 */
export function App({ client }: { readonly client: ShadowApiClient }) {
  const [route, rawNavigate] = useHashRoute();

  const mintedSessionIdRef = useRef<string | undefined>(undefined);
  // F3 review fix: bumped whenever `navigate` leaves a chat route that had a
  // session for an id-less one — see this component's doc.
  const [newChatNonce, setNewChatNonce] = useState(0);

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
      // F3 review fix: any transition off a session-carrying chat route
      // (self-minted or resumed) onto an id-less one needs a fresh mount —
      // not scoped to "same slug" or "was a delete" specifically, since any
      // such transition (delete-the-open-session today; a future
      // "start over" action) needs the same fresh transcript state.
      const isLeavingSessionForIdLessChat =
        route.name === "chat" &&
        route.sessionId !== undefined &&
        next.name === "chat" &&
        next.sessionId === undefined;
      if (isLeavingSessionForIdLessChat) {
        setNewChatNonce((n) => n + 1);
      }
      rawNavigate(next, options);
    },
    [route, rawNavigate],
  );

  // Consumes the one-shot exemption the render immediately after it took
  // effect. Mutating a ref never itself triggers a re-render, so this only
  // ever matters the NEXT time `route` genuinely changes — by which point
  // the self-mint has already done its one job (keeping the key stable for
  // the render where `route.sessionId` first became defined) and clearing
  // it here can't retroactively change a key already computed.
  useEffect(() => {
    if (
      route.name === "chat" &&
      route.sessionId !== undefined &&
      route.sessionId === mintedSessionIdRef.current
    ) {
      mintedSessionIdRef.current = undefined;
    }
  }, [route]);

  const isSelfMintedSession =
    route.name === "chat" &&
    route.sessionId !== undefined &&
    route.sessionId === mintedSessionIdRef.current;

  const chatKey =
    route.name !== "chat"
      ? undefined
      : isSelfMintedSession || route.sessionId === undefined
        ? `new-${newChatNonce}`
        : route.sessionId;

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
