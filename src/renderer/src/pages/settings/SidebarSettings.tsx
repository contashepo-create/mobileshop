import { useState } from 'react';
import { RotateCcw, ChevronDown, ChevronLeft, Plus, Trash2, Folder, Edit3, ArrowUp, ArrowDown, MoveRight, Star, X, Check } from 'lucide-react';
import { useSidebarStore } from '../../stores/sidebar.store';

const defaultSections: { label: string; children: { path: string; label: string }[] }[] = [
  {
    label: 'الحسابات',
    children: [
      { path: '/accounting/sales', label: 'مبيعات' },
      { path: '/accounting/purchases', label: 'مشتريات' },
      { path: '/accounting/maintenance', label: 'صيانة' },
      { path: '/accounting/vouchers', label: 'سندات' },
      { path: '/accounting/payroll', label: 'رواتب وسلف' },
      { path: '/accounting/rents', label: 'إيجارات' },
      { path: '/accounting/services', label: 'تحويل وشحن' },
      { path: '/accounting/fiscal-year', label: 'السنة المالية' },
      { path: '/accounting/settlement', label: 'التسوية الجردية' },
      { path: '/accounting/opening-balances', label: 'الأرصدة الافتتاحية' },
    ],
  },
  {
    label: 'الموارد البشرية',
    children: [
      { path: '/hr/employees', label: 'الموظفين' },
      { path: '/hr/customers', label: 'العملاء' },
      { path: '/hr/suppliers', label: 'الموردين' },
    ],
  },
  {
    label: 'الأصول',
    children: [
      { path: '/assets', label: 'البنوك والخزائن' },
      { path: '/assets/payment-methods', label: 'ماكينات الدفع' },
      { path: '/assets/transfers', label: 'تحويلات بين الحسابات' },
    ],
  },
  {
    label: 'التقارير',
    children: [
      { path: '/reports', label: 'التقارير العامة' },
      { path: '/reports/customer-statement', label: 'كشف حساب عميل' },
      { path: '/reports/supplier-statement', label: 'كشف حساب مورد' },
      { path: '/reports/employee-statement', label: 'كشف حساب موظف' },
    ],
  },
];

export function SidebarSettings() {
  const { config, updateMainOrder, updateChildrenOrder, addCustomSection, removeCustomSection, moveChildToSection, renameItem, promoteChildToMain, demoteMainToChild, moveStandaloneToSection, resetConfig, getDisplayLabel } = useSidebarStore();
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set(config.mainOrder.filter((l) => {
    const def = defaultSections.find((d) => d.label === l);
    return def || config.customSections[l];
  })));
  const [newSectionName, setNewSectionName] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');



  const toggleSection = (label: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const startEdit = (key: string) => {
    setEditingKey(key);
    setEditValue(getDisplayLabel(key));
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setEditValue('');
  };

  const confirmEdit = () => {
    if (editingKey && editValue.trim()) {
      renameItem(editingKey, editValue.trim());
    }
    cancelEdit();
  };

  // Get all section labels that can accept children
  const sectionLabels = config.mainOrder.filter((l) => {
    const hasDef = defaultSections.some((d) => d.label === l);
    const isCustom = !!config.customSections[l];
    return hasDef || isCustom;
  });

  // Get previous/next section labels for a given section
  const getAdjacentSections = (currentLabel: string) => {
    const idx = sectionLabels.indexOf(currentLabel);
    return {
      prev: idx > 0 ? sectionLabels[idx - 1] : null,
      next: idx < sectionLabels.length - 1 ? sectionLabels[idx + 1] : null,
    };
  };

  // Get all items in a section's children order that weren't moved away
  const getSectionChildren = (sectionLabel: string) => {
    return config.childrenOrder[sectionLabel] || [];
  };

  const moveChildUp = (sectionLabel: string, childIdx: number) => {
    if (childIdx <= 0) return;
    const order = [...getSectionChildren(sectionLabel)];
    [order[childIdx - 1], order[childIdx]] = [order[childIdx], order[childIdx - 1]];
    updateChildrenOrder(sectionLabel, order);
  };

  const moveChildDown = (sectionLabel: string, childIdx: number) => {
    const order = [...getSectionChildren(sectionLabel)];
    if (childIdx >= order.length - 1) return;
    [order[childIdx], order[childIdx + 1]] = [order[childIdx + 1], order[childIdx]];
    updateChildrenOrder(sectionLabel, order);
  };

  const moveChildToAdjacentSection = (path: string, fromSection: string, toSection: string) => {
    if (toSection && fromSection !== toSection) {
      moveChildToSection(path, fromSection, toSection);
    }
  };

  const moveMainUp = (idx: number) => {
    if (idx <= 0) return;
    const order = [...config.mainOrder];
    [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
    updateMainOrder(order);
  };

  const moveMainDown = (idx: number) => {
    if (idx >= config.mainOrder.length - 1) return;
    const order = [...config.mainOrder];
    [order[idx], order[idx + 1]] = [order[idx + 1], order[idx]];
    updateMainOrder(order);
  };

  const handleAddSection = () => {
    const name = newSectionName.trim();
    if (!name) return;
    addCustomSection(name);
    setNewSectionName('');
    setExpandedSections((prev) => { const n = new Set(prev); n.add(name); return n; });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-slate-800 dark:text-white">ترتيب القائمة الجانبية</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">استخدم الأزرار لإعادة ترتيب العناصر وتعديل أسمائها</p>
        </div>
        <button
          onClick={resetConfig}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-primary-600 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded-lg transition-colors"
        >
          <RotateCcw size={14} />
          إعادة تعيين
        </button>
      </div>

      <div className="space-y-3">
        {config.mainOrder.map((label, mainIdx) => {
          const def = defaultSections.find((d) => d.label === label);
          const isCustom = !!config.customSections[label];
          const isStandalone = !def && !isCustom;
          const hasChildren = !!def || isCustom;

          return (
            <div key={label} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
              {/* Main item row */}
              <div className={`flex items-center gap-1.5 px-3 py-2.5 transition-colors ${hasChildren ? 'bg-slate-50 dark:bg-slate-700/50 border-b border-slate-200 dark:border-slate-700' : ''}`}>
                <div className="flex items-center gap-0.5">
                  <button onClick={() => moveMainUp(mainIdx)} className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors" title="تحريك لأعلى"><ArrowUp size={14} /></button>
                  <button onClick={() => moveMainDown(mainIdx)} className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors" title="تحريك لأسفل"><ArrowDown size={14} /></button>
                </div>

                {hasChildren && (
                  <button onClick={() => toggleSection(label)} className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
                    {expandedSections.has(label) ? <ChevronDown size={15} /> : <ChevronLeft size={15} />}
                  </button>
                )}

                {isCustom && <Folder size={15} className="text-primary-500 flex-shrink-0" />}

                <div className="flex-1 min-w-0">
                  {editingKey === label ? (
                    <div className="flex items-center gap-1">
                      <input
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') confirmEdit(); if (e.key === 'Escape') cancelEdit(); }}
                        className="flex-1 px-2 py-0.5 text-sm rounded border border-primary-300 dark:border-primary-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white focus:outline-none focus:ring-1 focus:ring-primary-500"
                        autoFocus
                      />
                      <button onClick={confirmEdit} className="p-1 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded"><Check size={14} /></button>
                      <button onClick={cancelEdit} className="p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded"><X size={14} /></button>
                    </div>
                  ) : (
                    <span className={`text-sm font-medium ${hasChildren ? 'text-slate-800 dark:text-white' : 'text-slate-600 dark:text-slate-300'}`}>
                      {getDisplayLabel(label)}
                      {isCustom && <span className="mr-1.5 text-[10px] text-primary-500">(مخصص)</span>}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-0.5">
                  {editingKey !== label && (
                    <button onClick={() => startEdit(label)} className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400 hover:text-primary-600 transition-colors" title="تعديل الاسم">
                      <Edit3 size={14} />
                    </button>
                  )}

                  {isCustom && (
                    <button onClick={() => removeCustomSection(label)} className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-red-400 hover:text-red-600 transition-colors" title="حذف القسم">
                      <Trash2 size={14} />
                    </button>
                  )}

                  {isStandalone && sectionLabels.length > 0 && (
                    <select
                      onChange={(e) => { if (e.target.value) moveStandaloneToSection(label, e.target.value); e.target.value = ''; }}
                      value=""
                      className="text-[10px] px-1 py-0.5 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 focus:outline-none"
                      title="نقل إلى قسم"
                    >
                      <option value="">نقل ↓</option>
                      {sectionLabels.map((s) => <option key={s} value={s}>{getDisplayLabel(s)}</option>)}
                    </select>
                  )}


                </div>
              </div>

              {/* Children items */}
              {hasChildren && expandedSections.has(label) && (
                <div className="mr-6 space-y-0.5 py-1.5 px-2">
                  {getSectionChildren(label).length === 0 ? (
                    <div className="text-[10px] text-slate-400 dark:text-slate-500 text-center py-2 italic border border-dashed border-slate-200 dark:border-slate-700 rounded-lg">
                      {isCustom ? 'قسم فارغ — أنشئ أقساماً فرعية بنقلها من أقسام أخرى' : 'جميع العناصر منقولة إلى أقسام أخرى'}
                    </div>
                  ) : (
                    getSectionChildren(label).map((path, childIdx) => {
                      const allChild = defaultSections.flatMap((s) => s.children).find((c) => c.path === path);
                      const adj = getAdjacentSections(label);

                      return (
                        <div key={path} className="flex items-center gap-1.5 px-3 py-2 rounded-lg transition-colors hover:bg-slate-50 dark:hover:bg-slate-700/30">
                          <div className="flex items-center gap-0.5">
                            <button onClick={() => moveChildUp(label, childIdx)} className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors" title="تحريك لأعلى"><ArrowUp size={12} /></button>
                            <button onClick={() => moveChildDown(label, childIdx)} className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors" title="تحريك لأسفل"><ArrowDown size={12} /></button>
                          </div>

                          <div className="flex-1 min-w-0">
                            {editingKey === path ? (
                              <div className="flex items-center gap-1">
                                <input
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') confirmEdit(); if (e.key === 'Escape') cancelEdit(); }}
                                  className="flex-1 px-2 py-0.5 text-xs rounded border border-primary-300 dark:border-primary-600 bg-white dark:bg-slate-700 text-slate-800 dark:text-white focus:outline-none focus:ring-1 focus:ring-primary-500"
                                  autoFocus
                                />
                                <button onClick={confirmEdit} className="p-0.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded"><Check size={12} /></button>
                                <button onClick={cancelEdit} className="p-0.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded"><X size={12} /></button>
                              </div>
                            ) : (
                              <span>
                                <span className="text-xs text-slate-600 dark:text-slate-300">{getDisplayLabel(path)}</span>
                                {!allChild && <span className="text-[9px] text-slate-400 dark:text-slate-500 mr-1">(مستقل)</span>}
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-0.5">
                            {editingKey !== path && (
                              <button onClick={() => startEdit(path)} className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400 hover:text-primary-600 transition-colors" title="تعديل الاسم">
                                <Edit3 size={11} />
                              </button>
                            )}

                            {/* Move to previous section */}
                            {adj.prev && (
                              <button onClick={() => moveChildToAdjacentSection(path, label, adj.prev!)} className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400 hover:text-orange-600 transition-colors" title={`نقل إلى ${getDisplayLabel(adj.prev)}`}>
                                <MoveRight size={11} className="rotate-180" />
                              </button>
                            )}

                            {/* Move to next section */}
                            {adj.next && (
                              <button onClick={() => moveChildToAdjacentSection(path, label, adj.next!)} className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400 hover:text-orange-600 transition-colors" title={`نقل إلى ${getDisplayLabel(adj.next)}`}>
                                <MoveRight size={11} />
                              </button>
                            )}

                            {/* Move to any section dropdown */}
                            <select
                              onChange={(e) => { if (e.target.value) moveChildToAdjacentSection(path, label, e.target.value); e.target.value = ''; }}
                              value=""
                              className="text-[9px] px-0.5 py-0.5 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-500 dark:text-slate-400 focus:outline-none"
                              title="نقل إلى قسم آخر"
                            >
                              <option value="">نقل</option>
                              {sectionLabels.filter((s) => s !== label).map((s) => (
                                <option key={s} value={s}>{getDisplayLabel(s)}</option>
                              ))}
                            </select>

                            <button onClick={() => promoteChildToMain(path, label)} className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400 hover:text-yellow-600 transition-colors" title="ترفيع إلى قسم رئيسي">
                              <Star size={11} />
                            </button>


                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add custom section */}
      <div className="flex items-center gap-2 p-3 bg-white dark:bg-slate-800 rounded-xl border border-dashed border-slate-300 dark:border-slate-600">
        <input
          type="text"
          value={newSectionName}
          onChange={(e) => setNewSectionName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAddSection(); }}
          placeholder="اسم القسم الجديد..."
          className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
        <button
          onClick={handleAddSection}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors"
        >
          <Plus size={16} />
          إضافة قسم
        </button>
      </div>


    </div>
  );
}
