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
  | { readonly name: "chat"; readonly slug: string }
  | { readonly name: "chapter"; readonly slug: string; readonly chapter: string }
  | { readonly name: "rulebooks" }
  | { readonly name: "rulebook"; readonly slug: string }
  | { readonly name: "rulebook-group"; readonly slug: string; readonly group: string };

export function routePath(route: Route): string {
  switch (route.name) {
    case "volumes":
      return "#/";
    case "volume":
      return `#/v/${encodeURIComponent(route.slug)}`;
    case "chat":
      return `#/v/${encodeURIComponent(route.slug)}/chat`;
    case "chapter":
      return `#/v/${encodeURIComponent(route.slug)}/c/${encodeURIComponent(route.chapter)}`;
    case "rulebooks":
      return "#/r";
    case "rulebook":
      return `#/r/${encodeURIComponent(route.slug)}`;
    case "rulebook-group":
      return `#/r/${encodeURIComponent(route.slug)}/g/${encodeURIComponent(route.group)}`;
  }
}

export function parseHash(hash: string): Route {
  const segments = hash.replace(/^#/, "").split("/").filter(Boolean);
  if (segments[0] === "v" && segments[1]) {
    const slug = decodeURIComponent(segments[1]);
    if (segments[2] === "chat") return { name: "chat", slug };
    if (segments[2] === "c" && segments[3]) {
      return { name: "chapter", slug, chapter: decodeURIComponent(segments[3]) };
    }
    return { name: "volume", slug };
  }
  if (segments[0] === "r") {
    if (!segments[1]) return { name: "rulebooks" };
    const slug = decodeURIComponent(segments[1]);
    if (segments[2] === "g" && segments[3]) {
      return { name: "rulebook-group", slug, group: decodeURIComponent(segments[3]) };
    }
    return { name: "rulebook", slug };
  }
  return { name: "volumes" };
}

export function useHashRoute(): readonly [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() =>
    parseHash(typeof location === "undefined" ? "" : location.hash),
  );

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    location.hash = routePath(next);
  }, []);

  return [route, navigate] as const;
}
