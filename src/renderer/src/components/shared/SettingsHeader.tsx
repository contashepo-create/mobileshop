import type { ReactNode } from 'react';
import { Save } from 'lucide-react';
import { Button } from '../ui/Button';

/**
 * The action bar for a settings page that saves EVERYTHING with one button.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three settings pages each had a single button that commits the whole page,
 * and every one of them put it at the very bottom:
 *
 *     PrintSettings         line 539 of 544   (99% down)
 *     NotificationSettings  line 478 of 485   (98% down)
 *     GeneralSettings       line 234 of 371   (63% down)
 *
 * PrintSettings is the worst of the three: it now carries the logo picker, the
 * layout controls, the column list and a per-document panel with six document
 * types. Changing the paper size for a purchase invoice means scrolling past
 * everything else to find out whether the change was kept. The button is not
 * only hard to reach — it is out of sight while the work is being done, so
 * there is no visible reminder that anything still needs saving.
 *
 * WHAT THIS COMPONENT DOES
 *   - puts the title and the save action at the TOP, where the eye starts
 *   - sticks to the top of the scroll area, so it stays reachable from any
 *     point on a long page
 *   - shows an explicit "غير محفوظ" marker when there are pending edits, which
 *     is the part a bottom button can never do: the state and the control are
 *     in the same place
 *   - disables the button when there is nothing to save, so pressing it always
 *     means something
 *
 * The bottom button is REMOVED rather than duplicated. Two buttons that do the
 * same thing invite the question of whether they really do, and on a page this
 * long the second one is simply never seen.
 */
export interface SettingsHeaderProps {
  /** The page heading. */
  title: string;
  /** One line explaining what the page controls. */
  description?: string;
  /** Called when the save button is pressed. */
  onSave: () => void;
  /** Disables the button and shows a spinner while a save is in flight. */
  saving?: boolean;
  /**
   * Whether anything has changed since the last load or save.
   *
   * Optional: a page that cannot cheaply tell leaves it undefined, and the
   * button stays enabled. Passing `false` is a positive claim that there is
   * nothing to save, and the button is disabled accordingly.
   */
  dirty?: boolean;
  /** Label for the save button. */
  saveLabel?: string;
  /** Extra controls placed beside the save button (reset, export...). */
  children?: ReactNode;
}

export function SettingsHeader({
  title,
  description,
  onSave,
  saving = false,
  dirty,
  saveLabel = 'حفظ',
  children,
}: SettingsHeaderProps) {
  // `undefined` means the page does not track changes, so the button must stay
  // usable. Only an explicit `false` disables it.
  const nothingToSave = dirty === false;

  return (
    <div
      className="sticky top-0 z-20 -mx-1 mb-2 flex flex-wrap items-center justify-between gap-3
                 rounded-xl border border-slate-200 bg-white/95 px-4 py-3 backdrop-blur
                 dark:border-slate-700 dark:bg-slate-800/95"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-lg font-semibold text-slate-800 dark:text-white">
            {title}
          </h2>
          {dirty === true && (
            <span
              className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium
                         text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
            >
              تغييرات غير محفوظة
            </span>
          )}
        </div>
        {description && (
          <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
            {description}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {children}
        <Button
          onClick={onSave}
          loading={saving}
          disabled={nothingToSave}
          icon={<Save size={16} />}
        >
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
