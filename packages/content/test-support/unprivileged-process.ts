// root 会绕过作者目录的权限限制；普通用户直接保留当前身份。
export const unprivilegedProcessOptions =
  process.geteuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
