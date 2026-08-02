import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * THE LAST LINE BETWEEN A RENDER BUG AND A BLANK WINDOW.
 *
 * WHY THIS IS NOT OPTIONAL HERE
 * -----------------------------
 * React unmounts the ENTIRE tree when a render throws and nothing catches it.
 * In a browser that is a broken page and a refresh; in this application it is
 * a shop mid-sale staring at a white rectangle, with the till drawer open and
 * a customer waiting. There is no address bar to reload from.
 *
 * The codebase already works hard to avoid render throws — `asRows`,
 * `isFailure`, and a verify suite that scans for unguarded dereferences. This
 * is the admission that none of that is proof. A boundary turns a fault that
 * destroys the session into one screen showing a message, with the data
 * untouched on disk.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not retry automatically, and it does not swallow the error. A render
 * that throws once usually throws again on the same state, so a silent retry
 * loop would burn CPU and hide the fault. The error is logged to the main
 * process — where the existing `console-message` listener records it — so a
 * report can say what actually happened rather than "the screen went white".
 */

interface Props {
  children: ReactNode;
  /** Names the area, so the message can say WHICH part failed. */
  area?: string;
  /** Renders instead of the default panel. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // `console.error` in the renderer is forwarded to the main process by the
    // `console-message` listener in index.ts, so this lands in the log the
    // developer already reads. Wrapped because a boundary that throws while
    // reporting an error is worse than the error.
    try {
      console.error(
        `[ErrorBoundary${this.props.area ? ' ' + this.props.area : ''}]`,
        error?.message,
        info?.componentStack,
      );
    } catch { /* never make the failure worse */ }
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6" dir="rtl">
        <div className="w-full max-w-lg rounded-xl border border-red-200 bg-white p-6 text-center
                        dark:border-red-900 dark:bg-slate-800">
          <div className="mb-2 text-4xl">⚠️</div>
          <h2 className="mb-2 text-lg font-bold text-slate-800 dark:text-white">
            حدث خطأ في هذه الشاشة
          </h2>
          {/* The reassurance that matters most: the books are on disk, and a
              render fault never touched them. */}
          <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">
            بياناتك سليمة ومحفوظة — لم يتأثر أي سجل. يمكنك المحاولة مرة أخرى أو الانتقال لقسم آخر.
          </p>
          <p className="mb-4 break-words rounded-lg bg-slate-50 p-2 text-xs text-slate-500
                        dark:bg-slate-900 dark:text-slate-400">
            {String(error?.message || error)}
          </p>
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={this.reset}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white
                         hover:bg-primary-700"
            >
              إعادة المحاولة
            </button>
            <button
              onClick={() => { window.location.hash = '#/'; this.reset(); }}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium
                         text-slate-700 hover:bg-slate-50
                         dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              الرئيسية
            </button>
          </div>
        </div>
      </div>
    );
  }
}
