import { ReactNode } from 'react';
import { asRows } from '../../lib/ipc';

interface Column<T> {
  key: string;
  title: string;
  render?: (row: T) => ReactNode;
  className?: string;
  width?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  /**
   * Declared as an array, but accepted as `unknown` at runtime on purpose.
   *
   * Every caller feeds this straight from a `useState` that was filled by an
   * IPC reply, so it can genuinely be `undefined` (payload of a different
   * shape, or a `{ success: false }` refusal from the permission guard) no
   * matter what the type says. This component is rendered on 38 screens; a
   * throw here unmounts the whole application, because the tree has no error
   * boundary. Showing the empty row instead is both honest and safe.
   */
  data: T[] | null | undefined;
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
  keyField?: string;
}

export function DataTable<T extends Record<string, any>>({
  columns,
  data,
  emptyMessage = 'لا توجد بيانات',
  onRowClick,
  keyField = 'id',
}: DataTableProps<T>) {
  const rows = asRows<T>(data);
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700">
            {columns.map((col) => (
              <th
                key={col.key}
                className={`px-4 py-3 text-right font-semibold text-slate-600 dark:text-slate-300 ${col.className || ''}`}
                style={col.width ? { width: col.width } : undefined}
              >
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row, idx) => (
              <tr
                key={row[keyField] ?? idx}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors ${
                  onRowClick ? 'cursor-pointer' : ''
                }`}
              >
                {columns.map((col) => (
                  <td key={col.key} className={`px-4 py-3 text-slate-700 dark:text-slate-200 ${col.className || ''}`}>
                    {col.render ? col.render(row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
