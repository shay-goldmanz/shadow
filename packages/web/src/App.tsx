import type { ShadowApiClient } from "./api/client.ts";
import { ChapterPage } from "./pages/ChapterPage.tsx";
import { ChatPage } from "./pages/ChatPage.tsx";
import { RulebookGroupPage } from "./pages/RulebookGroupPage.tsx";
import { RulebookListPage } from "./pages/RulebookListPage.tsx";
import { RulebookViewPage } from "./pages/RulebookViewPage.tsx";
import { VolumeListPage } from "./pages/VolumeListPage.tsx";
import { VolumeViewPage } from "./pages/VolumeViewPage.tsx";
import { useHashRoute } from "./routing/useHashRoute.ts";
import { ThemeToggle } from "./theme/ThemeToggle.tsx";

/** The whole app: no domain logic (docs/ARCHITECTURE.md), just routing over one API client and seven screens. */
export function App({ client }: { readonly client: ShadowApiClient }) {
  const [route, navigate] = useHashRoute();

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
        <nav className="app-shell__nav" aria-label="Primary">
          <button
            type="button"
            className="app-shell__nav-link"
            aria-current={route.name === "volumes" || route.name === "volume" ? "page" : undefined}
            onClick={() => navigate({ name: "volumes" })}
          >
            Volumes
          </button>
          <button
            type="button"
            className="app-shell__nav-link"
            aria-current={
              route.name === "rulebooks" ||
              route.name === "rulebook" ||
              route.name === "rulebook-group"
                ? "page"
                : undefined
            }
            onClick={() => navigate({ name: "rulebooks" })}
          >
            Rule books
          </button>
        </nav>
        <ThemeToggle />
      </header>
      <main id="main" className="app-shell__main">
        {route.name === "volumes" && <VolumeListPage client={client} navigate={navigate} />}
        {route.name === "volume" && (
          <VolumeViewPage client={client} slug={route.slug} navigate={navigate} />
        )}
        {route.name === "chat" && (
          <ChatPage client={client} slug={route.slug} navigate={navigate} />
        )}
        {route.name === "chapter" && (
          <ChapterPage
            client={client}
            slug={route.slug}
            chapterSlug={route.chapter}
            navigate={navigate}
          />
        )}
        {route.name === "rulebooks" && <RulebookListPage client={client} navigate={navigate} />}
        {route.name === "rulebook" && (
          <RulebookViewPage client={client} slug={route.slug} navigate={navigate} />
        )}
        {route.name === "rulebook-group" && (
          <RulebookGroupPage
            client={client}
            slug={route.slug}
            groupSlug={route.group}
            navigate={navigate}
          />
        )}
      </main>
    </div>
  );
}
