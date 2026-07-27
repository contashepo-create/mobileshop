import { useState, useEffect } from 'react';
import { UserPlus, Shield, Lock, Unlock, ChevronDown, ChevronLeft, ChevronRight, Key, Users, Settings2, Plus, Trash2, Save, X } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input, Select } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/Badge';
import { DataTable } from '../../components/shared/DataTable';
import { useToastStore } from '../../components/ui/Toast';

interface UserRow {
  UserID: number;
  Username: string;
  IsActive: number;
  EmployeeID?: number;
  EmployeeName?: string;
  RoleID: number;
  RoleName: string;
}

interface Role {
  RoleID: number;
  RoleName: string;
  IsSystem: number;
}

interface Permission {
  PermissionID: number;
  PermissionKey: string;
  PermissionName: string;
  Module: string;
}

export function UsersSettings() {
  const { showToast } = useToastStore();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);
  const [showUserModal, setShowUserModal] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [rolePermissions, setRolePermissions] = useState<Set<number>>(new Set());
  const [userOverrides, setUserOverrides] = useState<Record<number, 'grant' | 'deny'>>({});
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetTargetUser, setResetTargetUser] = useState<UserRow | null>(null);
  const [resetNewPass, setResetNewPass] = useState('');
  const [resetAdminPass, setResetAdminPass] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [roleName, setRoleName] = useState('');
  const [rolePerms, setRolePerms] = useState<Set<number>>(new Set());
  const [activeTab, setActiveTab] = useState<'users' | 'roles'>('users');

  // Form state
  const [formUsername, setFormUsername] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formEmployeeId, setFormEmployeeId] = useState('');
  const [formRoleId, setFormRoleId] = useState('1');

  const fetchData = async () => {
    const [u, r, e] = await Promise.all([
      window.api.invoke('users:list'),
      window.api.invoke('roles:list'),
      window.api.invoke('employees:list', { isActive: 1 }),
    ]);
    setUsers(u);
    setRoles(r);
    setEmployees(e);
  };

  useEffect(() => {
    fetchData();
  }, []);

  const openCreateModal = () => {
    setEditingUser(null);
    setFormUsername('');
    setFormPassword('');
    setFormEmployeeId('');
    setFormRoleId('1');
    setShowUserModal(true);
  };

  const openEditModal = (user: UserRow) => {
    setEditingUser(user);
    setFormUsername(user.Username);
    setFormPassword('');
    setFormEmployeeId(user.EmployeeID?.toString() || '');
    setFormRoleId(user.RoleID.toString());
    setShowUserModal(true);
  };

  const handleSaveUser = async () => {
    if (!formUsername) {
      showToast('error', 'يرجى إدخال اسم المستخدم');
      return;
    }
    const data = {
      username: formUsername,
      password: formPassword,
      employeeId: formEmployeeId ? parseInt(formEmployeeId) : undefined,
      roleId: parseInt(formRoleId),
    };
    if (editingUser) {
      await window.api.invoke('users:update', editingUser.UserID, data);
      showToast('success', 'تم تحديث المستخدم');
    } else {
      if (!formPassword) {
        showToast('error', 'يرجى إدخال كلمة المرور');
        return;
      }
      const result = await window.api.invoke('users:create', data);
      if (!result.success) {
        showToast('error', result.message);
        return;
      }
      showToast('success', 'تم إنشاء المستخدم');
    }
    setShowUserModal(false);
    fetchData();
  };

  // ===== PASSWORD RESET =====
  const openResetModal = (user: UserRow) => {
    setResetTargetUser(user);
    setResetNewPass('');
    setResetAdminPass('');
    setShowResetModal(true);
  };

  const handleResetPassword = async () => {
    if (!resetTargetUser || !resetAdminPass || !resetNewPass) {
      showToast('error', 'يرجى إدخال جميع الحقول');
      return;
    }
    if (resetNewPass.length < 4) {
      showToast('error', 'كلمة المرور الجديدة يجب أن تكون 4 أحرف على الأقل');
      return;
    }
    setResetLoading(true);
    const result = await window.api.invoke('users:adminResetPassword', {
      adminId: parseInt(localStorage.getItem('userId') || '0'),
      adminPassword: resetAdminPass,
      targetUserId: resetTargetUser.UserID,
      newPassword: resetNewPass,
    });
    setResetLoading(false);
    if (result.success) {
      showToast('success', result.message);
      setShowResetModal(false);
    } else {
      showToast('error', result.message);
    }
  };

  // ===== ROLE MANAGEMENT =====
  const openRoleModal = async (role?: Role) => {
    setEditingRole(role || null);
    setRoleName(role?.RoleName || '');
    setShowRoleModal(true);
    if (role) {
      await loadRolePerms(role.RoleID);
    } else {
      setRolePerms(new Set());
    }
  };

  const loadRolePerms = async (roleId: number) => {
    const rp = await window.api.invoke('permissions:getByRole', roleId);
    setRolePerms(new Set(rp.map((p: any) => p.PermissionID)));
  };

  const handleSaveRole = async () => {
    if (!roleName.trim()) {
      showToast('error', 'يرجى إدخال اسم المجموعة');
      return;
    }
    if (editingRole) {
      await window.api.invoke('roles:update', editingRole.RoleID, roleName.trim());
      await window.api.invoke('permissions:setForRole', editingRole.RoleID, Array.from(rolePerms));
      showToast('success', 'تم تحديث المجموعة');
    } else {
      const result = await window.api.invoke('roles:create', roleName.trim());
      if (!result.success) {
        showToast('error', result.message);
        return;
      }
      await window.api.invoke('permissions:setForRole', result.id, Array.from(rolePerms));
      showToast('success', 'تم إنشاء المجموعة');
    }
    setShowRoleModal(false);
    fetchData();
  };

  const handleDeleteRole = async (role: Role) => {
    if (!confirm(`هل تريد حذف المجموعة "${role.RoleName}"؟ سيتم تحويل مستخدميها إلى الدور الافتراضي.`)) return;
    const result = await window.api.invoke('roles:delete', role.RoleID);
    if (result.success) {
      showToast('success', result.message);
      fetchData();
    } else {
      showToast('error', result.message);
    }
  };

  // ===== PERMISSIONS PANEL =====
  const openPermissions = async (userId: number) => {
    setSelectedUserId(userId);
    const perms = await window.api.invoke('permissions:list');
    setPermissions(perms);
    const user = users.find((u) => u.UserID === userId);
    if (user) {
      const rp = await window.api.invoke('permissions:getByRole', user.RoleID);
      setRolePermissions(new Set(rp.map((p: any) => p.PermissionID)));
    }
    const overrides = await window.api.invoke('permissions:getOverrides', userId);
    const overrideMap: Record<number, 'grant' | 'deny'> = {};
    for (const o of overrides) {
      overrideMap[o.PermissionID] = o.Type;
    }
    setUserOverrides(overrideMap);
  };

  const toggleOverride = async (permId: number, type: 'grant' | 'deny') => {
    if (!selectedUserId) return;
    if (userOverrides[permId] === type) {
      // Remove override
      await window.api.invoke('permissions:removeOverride', selectedUserId, permId);
      const next = { ...userOverrides };
      delete next[permId];
      setUserOverrides(next);
    } else {
      await window.api.invoke('permissions:setOverride', selectedUserId, permId, type);
      setUserOverrides({ ...userOverrides, [permId]: type });
    }
  };

  // Group permissions by module
  const modules = permissions.reduce((acc, perm) => {
    if (!acc[perm.Module]) acc[perm.Module] = [];
    acc[perm.Module].push(perm);
    return acc;
  }, {} as Record<string, Permission[]>);

  const moduleNames: Record<string, string> = {
    dashboard: 'لوحة التحكم',
    sales: 'المبيعات',
    purchases: 'المشتريات',
    maintenance: 'الصيانة',
    vouchers: 'السندات',
    payroll: 'الرواتب',
    rent: 'الإيجارات',
    settlements: 'التسويات',
    fiscal_year: 'السنة المالية',
    inventory: 'المخازن',
    hr: 'الموارد البشرية',
    assets: 'الأصول',
    reports: 'التقارير',
    settings: 'الإعدادات',
  };

  if (selectedUserId) {
    const user = users.find((u) => u.UserID === selectedUserId);
    return (
      <div className="space-y-4">
        <button
          onClick={() => setSelectedUserId(null)}
          className="flex items-center gap-1 text-sm text-slate-500 dark:text-slate-500 dark:text-slate-400 hover:text-primary-600"
        >
          <ChevronRight size={16} /> رجوع لقائمة المستخدمين
        </button>

        <div className="flex items-center gap-3">
          <Shield size={20} className="text-primary-600" />
          <h2 className="text-lg font-semibold text-slate-800 dark:text-white">
            صلاحيات: {user?.Username}
          </h2>
          <Badge variant="blue">{user?.RoleName}</Badge>
        </div>

        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 text-sm text-blue-700 dark:text-blue-300">
          الصلاحيات الأخضر هي الصلاحيات الممنوحة للدور. يمكنك منح صلاحية إضافية (زر +) أو منع صلاحية (زر −) لهذا المستخدم بشكل فردي.
        </div>

        <div className="space-y-4">
          {Object.entries(modules).map(([module, perms]) => (
            <div key={module} className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">
                {moduleNames[module] || module}
              </h3>
              <div className="space-y-2">
                {perms.map((perm) => {
                  const hasRolePerm = rolePermissions.has(perm.PermissionID);
                  const override = userOverrides[perm.PermissionID];
                  const effective = override === 'grant' || (!override && hasRolePerm && override !== 'deny');
                  return (
                    <div key={perm.PermissionID} className="flex items-center justify-between py-1.5">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm ${effective ? 'text-slate-700 dark:text-slate-200' : 'text-slate-500 dark:text-slate-400'}`}>
                          {perm.PermissionName}
                        </span>
                        {hasRolePerm && <Badge variant="blue" className="text-[10px]">دور</Badge>}
                        {override === 'grant' && <Badge variant="green" className="text-[10px]">إضافة</Badge>}
                        {override === 'deny' && <Badge variant="red" className="text-[10px]">منع</Badge>}
                      </div>
                      <div className="flex gap-1">
                        <button
                          onClick={() => toggleOverride(perm.PermissionID, 'grant')}
                          className={`w-7 h-7 rounded flex items-center justify-center text-xs transition-colors ${
                            override === 'grant'
                              ? 'bg-green-600 text-white'
                              : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 hover:bg-green-100 hover:text-green-600'
                          }`}
                          title="منح إضافي"
                        >
                          +
                        </button>
                        <button
                          onClick={() => toggleOverride(perm.PermissionID, 'deny')}
                          className={`w-7 h-7 rounded flex items-center justify-center text-xs transition-colors ${
                            override === 'deny'
                              ? 'bg-red-600 text-white'
                              : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 hover:bg-red-100 hover:text-red-600'
                          }`}
                          title="منع"
                        >
                          −
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

   return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab('users')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'users' ? 'bg-primary-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}`}
          >
            المستخدمون
          </button>
          <button
            onClick={() => setActiveTab('roles')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'roles' ? 'bg-primary-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300'}`}
          >
            المجموعات
          </button>
        </div>
        {activeTab === 'users' && (
          <Button onClick={openCreateModal} icon={<UserPlus size={16} />}>
            مستخدم جديد
          </Button>
        )}
      </div>

      <DataTable
        columns={[
          { key: 'Username', title: 'اسم المستخدم' },
          { key: 'EmployeeName', title: 'الموظف', render: (row) => row.EmployeeName || '—' },
          { key: 'RoleName', title: 'الدور', render: (row) => <Badge variant="blue">{row.RoleName}</Badge> },
          {
            key: 'IsActive',
            title: 'الحالة',
            render: (row) => (
              <Badge variant={row.IsActive ? 'green' : 'gray'}>
                {row.IsActive ? 'نشط' : 'متوقف'}
              </Badge>
            ),
          },
          {
            key: 'actions',
            title: 'إجراءات',
            render: (row) => (
              <div className="flex gap-2">
                <button
                  onClick={() => openEditModal(row)}
                  className="text-xs text-primary-600 hover:underline"
                >
                  تعديل
                </button>
                <button
                  onClick={() => openResetModal(row)}
                  className="text-xs text-orange-600 hover:underline flex items-center gap-1"
                >
                  <Key size={11} /> كلمة المرور
                </button>
                <button
                  onClick={() => openPermissions(row.UserID)}
                  className="text-xs text-slate-500 dark:text-slate-500 dark:text-slate-400 hover:text-primary-600 flex items-center gap-1"
                >
                  <Shield size={12} /> الصلاحيات
                </button>
              </div>
            ),
          },
        ]}
        data={users}
        keyField="UserID"
         emptyMessage="لا يوجد مستخدمون"
       />

       {/* Roles Tab */}
       {activeTab === 'roles' && (
         <div className="space-y-4">
           <div className="flex items-center justify-between">
             <h2 className="text-lg font-semibold text-slate-800 dark:text-white">إدارة المجموعات</h2>
             <Button onClick={() => openRoleModal()} icon={<Plus size={16} />}>
               مجموعة جديدة
             </Button>
           </div>
           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
             {roles.map((role) => (
               <div key={role.RoleID} className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
                 <div className="flex items-center justify-between mb-2">
                   <h3 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
                     {role.RoleName}
                     {role.IsSystem && <Badge variant="blue" className="text-[10px]">نظامية</Badge>}
                   </h3>
                 </div>
                 <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
                   {/* TODO: count users */}
                 </p>
                 <div className="flex gap-2">
                   {!role.IsSystem && (
                     <>
                       <button
                         onClick={() => openRoleModal(role)}
                         className="text-xs text-primary-600 hover:underline"
                       >
                         تعديل
                       </button>
                       <button
                         onClick={() => handleDeleteRole(role)}
                         className="text-xs text-red-500 hover:underline"
                       >
                         حذف
                       </button>
                     </>
                   )}
                 </div>
               </div>
             ))}
           </div>
         </div>
       )}

       {/* Create/Edit User Modal */}
       <Modal
         isOpen={showUserModal}
         onClose={() => setShowUserModal(false)}
         title={editingUser ? 'تعديل مستخدم' : 'مستخدم جديد'}
         footer={
           <>
             <Button variant="secondary" onClick={() => setShowUserModal(false)}>إلغاء</Button>
             <Button onClick={handleSaveUser}>حفظ</Button>
           </>
         }
       >
        <div className="space-y-4">
          <Input
            label="اسم المستخدم"
            value={formUsername}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormUsername(e.target.value)}
          />
          <Input
            label={editingUser ? 'كلمة المرور (اتركها فارغة لعدم التغيير)' : 'كلمة المرور'}
            type="password"
            value={formPassword}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormPassword(e.target.value)}
          />
          <Select
            label="الموظف"
            value={formEmployeeId}
            onChange={(e) => setFormEmployeeId(e.target.value)}
            options={[
              { value: '', label: '— بدون ربط بموظف —' },
              ...employees.map((emp: any) => ({ value: emp.EmployeeID.toString(), label: `${emp.Name} (${emp.Position || ''})` })),
            ]}
          />
          <Select
            label="الدور"
            value={formRoleId}
            onChange={(e) => setFormRoleId(e.target.value)}
            options={roles.map((r) => ({ value: r.RoleID.toString(), label: r.RoleName }))}
          />
        </div>
       </Modal>

       {/* Reset Password Modal */}
       <Modal
         isOpen={showResetModal}
         onClose={() => setShowResetModal(false)}
         title="إعادة تعيين كلمة المرور"
         footer={
           <>
             <Button variant="secondary" onClick={() => setShowResetModal(false)}>إلغاء</Button>
             <Button onClick={handleResetPassword} loading={resetLoading}>إعادة التعيين</Button>
           </>
         }
       >
         <div className="space-y-4">
           <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-3 text-xs text-orange-700 dark:text-orange-300">
             سيتم تغيير كلمة المرور للمستخدم <strong>{resetTargetUser?.Username}</strong>. أدخل كلمة مرورك الحالية للمصادقة.
           </div>
           <Input label="كلمة المرور الحالية" type="password" value={resetAdminPass} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setResetAdminPass(e.target.value)} />
           <Input label="كلمة المرور الجديدة" type="password" value={resetNewPass} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setResetNewPass(e.target.value)} />
         </div>
       </Modal>

       {/* Role Management Modal */}
       <Modal
         isOpen={showRoleModal}
         onClose={() => setShowRoleModal(false)}
         title={editingRole ? 'تعديل مجموعة' : 'مجموعة جديدة'}
         footer={
           <>
             <Button variant="secondary" onClick={() => setShowRoleModal(false)}>إلغاء</Button>
             <Button onClick={handleSaveRole} icon={<Save size={16} />}>حفظ</Button>
           </>
         }
       >
         <div className="space-y-4">
           <Input label="اسم المجموعة" value={roleName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRoleName(e.target.value)} />
           <div className="max-h-80 overflow-y-auto space-y-2">
              {Object.entries(modules).map(([module, perms]: [string, Permission[]]) => (
               <div key={module} className="bg-slate-50 dark:bg-slate-800 rounded-lg p-3">
                 <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">{moduleNames[module] || module}</h4>
                 <div className="space-y-1">
                   {perms.map((perm) => (
                     <label key={perm.PermissionID} className="flex items-center gap-2 py-1 cursor-pointer">
                       <input
                         type="checkbox"
                         checked={rolePerms.has(perm.PermissionID)}
                         onChange={() => {
                           const next = new Set(rolePerms);
                           if (next.has(perm.PermissionID)) next.delete(perm.PermissionID);
                           else next.add(perm.PermissionID);
                           setRolePerms(next);
                         }}
                         className="w-4 h-4 rounded text-primary-600"
                       />
                       <span className="text-sm text-slate-700 dark:text-slate-300">{perm.PermissionName}</span>
                     </label>
                   ))}
                 </div>
               </div>
             ))}
           </div>
         </div>
       </Modal>
     </div>
   );
 }
