import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryState {
  readonly error: Error | undefined;
}

/**
 * The last line of defence against exactly the failure mode this
 * reconciliation was built to catch: a page-level crash (a shape the
 * client didn't expect, a `.map` on the wrong type) currently unmounts
 * React entirely, leaving `#root` empty — silent to a sighted operator and
 * to assistive tech alike (nothing is announced; there is nothing to
 * announce). This renders a visible, `role="alert"` fallback instead, so a
 * future divergence fails loudly rather than as a blank screen.
 */
export class ErrorBoundary extends Component<{ readonly children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // biome-ignore lint/suspicious/noConsole: the one place this app is allowed to log — there is no telemetry pillar to report to instead.
    console.error("Shadow interface crashed:", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="page error-boundary" role="alert">
        <h1>Something went wrong</h1>
        <p>The interface hit an unexpected error and could not render this screen.</p>
        <pre className="error-boundary__detail">{error.message}</pre>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
