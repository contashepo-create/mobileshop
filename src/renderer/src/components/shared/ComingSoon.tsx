import { Wrench } from 'lucide-react';

export function ComingSoon({ title }: { title: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center">
      <div className="w-16 h-16 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-4">
        <Wrench size={28} className="text-slate-500 dark:text-slate-400" />
      </div>
      <h2 className="text-xl font-semibold text-slate-700 dark:text-slate-200 mb-2">{title}</h2>
      <p className="text-slate-500 dark:text-slate-400 text-sm">هذا القسم قيد التطوير</p>
    </div>
  );
}
