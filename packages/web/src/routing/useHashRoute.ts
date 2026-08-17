import { useCallback, useEffect, useState } from "react";

/**
 * A minimal hash router. D10/the task ask for four screens and nothing
 * router-shaped beyond them, so a ~40-line hook keeps the dependency list
 * to "React plus what is genuinely needed" instead of pulling in
 * react-router for four routes.
 */
export type Route =
  | { readonly name: "volumes" }
  | { readonly name: "volume"; readonly slug: string }
  // `sessionId` present = `#/v/:slug/chat/:sessionId`, the session's own
  // address (T2.8): mounting it replays the stored transcript and follows
  // it live. Absent = `#/v/:slug/chat`, "start a new chat" — `ChatPage`
  // navigates away from this form the moment the first send's `session`
  // wire event mints an id (`NavigateOptions.replace`, below).
  | { readonly name: "chat"; readonly slug: string; readonly sessionId?: string }
  | { readonly name: "chapter"; readonly slug: string; readonly chapter: string };

/** `navigate`'s options. `replace: true` swaps the current history entry instead of pushing a new one — T2.8's id-less-chat-to-id-carrying-chat transition uses this so the browser's back button leaves the chat screen instead of bouncing back to the id-less URL that only ever existed for the instant before the first message was sent. */
export interface NavigateOptions {
  readonly replace?: boolean;
}

export function routePath(route: Route): string {
  switch (route.name) {
    case "volumes":
      return "#/";
    case "volume":
      return `#/v/${encodeURIComponent(route.slug)}`;
    case "chat":
      return route.sessionId === undefined
        ? `#/v/${encodeURIComponent(route.slug)}/chat`
        : `#/v/${encodeURIComponent(route.slug)}/chat/${encodeURIComponent(route.sessionId)}`;
    case "chapter":
      return `#/v/${encodeURIComponent(route.slug)}/c/${encodeURIComponent(route.chapter)}`;
  }
}

export function parseHash(hash: string): Route {
  const segments = hash.replace(/^#/, "").split("/").filter(Boolean);
  if (segments[0] === "v" && segments[1]) {
    const slug = decodeURIComponent(segments[1]);
    if (segments[2] === "chat") {
      return segments[3] !== undefined
        ? { name: "chat", slug, sessionId: decodeURIComponent(segments[3]) }
        : { name: "chat", slug };
    }
    if (segments[2] === "c" && segments[3]) {
      return { name: "chapter", slug, chapter: decodeURIComponent(segments[3]) };
    }
    return { name: "volume", slug };
  }
  return { name: "volumes" };
}

export function useHashRoute(): readonly [
  Route,
  (route: Route, options?: NavigateOptions) => void,
] {
  const [route, setRoute] = useState<Route>(() =>
    parseHash(typeof location === "undefined" ? "" : location.hash),
  );

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: Route, options: NavigateOptions = {}) => {
    if (options.replace) {
      // `history.replaceState` does not fire `hashchange` (unlike setting
      // `location.hash`, below) — `setRoute` mirrors it locally so this
      // hook's own state stays in sync with the URL it just replaced.
      history.replaceState(null, "", routePath(next));
      setRoute(next);
      return;
    }
    location.hash = routePath(next);
  }, []);

  return [route, navigate] as const;
}
