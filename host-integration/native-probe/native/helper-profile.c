#define _GNU_SOURCE
#include "mechanisms.h"
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <linux/securebits.h>
#include <sched.h>
#include <stddef.h>
#include <sys/fsuid.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>
#define NP_SECUREBITS (SECBIT_NOROOT | SECBIT_NOROOT_LOCKED | SECBIT_NO_SETUID_FIXUP | SECBIT_NO_SETUID_FIXUP_LOCKED | SECBIT_KEEP_CAPS_LOCKED | SECBIT_NO_CAP_AMBIENT_RAISE | SECBIT_NO_CAP_AMBIENT_RAISE_LOCKED)
int np_helper_reduce_v1(void) {
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0)) return -1;
  int last = -1;
  for (int cap = 0; cap < 64; cap++) {
    int present = prctl(PR_CAPBSET_READ, cap, 0, 0, 0);
    if (present < 0) { if (errno != EINVAL) return -1; last = cap - 1; break; }
    if (prctl(PR_CAPBSET_DROP, cap, 0, 0, 0)) return -1;
  }
  if (last < 0 || prctl(PR_SET_SECUREBITS, NP_SECUREBITS, 0, 0, 0) || setgroups(0, NULL) || setresgid(NP_GID, NP_GID, NP_GID) || setresuid(NP_UID, NP_UID, NP_UID)) return -1;
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct caps[2] = { {0}, {0} };
  if (syscall(SYS_capset, &header, caps) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return -1;
  return 0;
}
int np_helper_verify_v1(void) {
  uid_t u[3]; gid_t g[3];
  if (getresuid(&u[0], &u[1], &u[2]) || getresgid(&g[0], &g[1], &g[2]) || u[0] != NP_UID || u[1] != NP_UID || u[2] != NP_UID || g[0] != NP_GID || g[1] != NP_GID || g[2] != NP_GID || setfsuid((uid_t)-1) != NP_UID || setfsgid((gid_t)-1) != NP_GID || getgroups(0, NULL) != 0 || prctl(PR_GET_SECUREBITS, 0, 0, 0, 0) != NP_SECUREBITS || prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1 || prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0) { errno = EPERM; return -1; }
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 }; struct __user_cap_data_struct caps[2];
  if (syscall(SYS_capget, &header, caps)) return -1;
  for (unsigned i = 0; i < 2; i++) if (caps[i].effective || caps[i].permitted || caps[i].inheritable) { errno = EPERM; return -1; }
  for (int cap = 0; cap < 64; cap++) {
    int bound = prctl(PR_CAPBSET_READ, cap, 0, 0, 0);
    if (bound < 0) return errno == EINVAL ? 0 : -1;
    if (bound || prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, cap, 0, 0) != 0) { errno = EPERM; return -1; }
  }
  errno = EOVERFLOW; return -1;
}
#define DENY(n) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_##n, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
#define LOAD_ARG(n) BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[n]))
int np_helper_preexec_filter_v1(void) {
#if !defined(__x86_64__)
  errno = ENOTSUP; return -1;
#else
  // Prevent Node/libuv from acquiring a ring before the full post-exec seal.
  // The original launcher owns the sole fixed exec; this filter cannot attest it.
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000U, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    DENY(io_uring_setup), DENY(io_uring_enter), DENY(io_uring_register),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
  };
  struct sock_fprog program = { .len = (unsigned short)(sizeof filter / sizeof filter[0]), .filter = filter };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return -1;
  long result = syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program);
  if (result != 0) { errno = EPERM; return -1; } return 0;
#endif
}
// x86-64 glibc pthread flags. clone3 is deliberately ENOSYS, so libc must use
// this fully checked clone path. Other ABIs/profile variants require admission.
#define NP_THREAD_FLAGS (CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SIGHAND | CLONE_THREAD | CLONE_SYSVSEM | CLONE_SETTLS | CLONE_PARENT_SETTID | CLONE_CHILD_CLEARTID)
int np_helper_filter_v1(void) {
#if !defined(__x86_64__)
  errno = ENOTSUP; return -1;
#else
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000U, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    DENY(fork), DENY(vfork), DENY(execve), DENY(execveat), DENY(setns), DENY(unshare),
    DENY(ptrace), DENY(pidfd_getfd), DENY(process_vm_readv), DENY(process_vm_writev), DENY(pidfd_send_signal),
    DENY(sendmsg), DENY(sendmmsg), DENY(socket), DENY(socketpair), DENY(connect), DENY(bind), DENY(listen), DENY(accept), DENY(accept4),
    DENY(dup), DENY(dup2), DENY(dup3), DENY(sendfile), DENY(splice), DENY(tee), DENY(vmsplice), DENY(copy_file_range),
    DENY(io_uring_setup), DENY(io_uring_enter), DENY(io_uring_register), DENY(bpf), DENY(userfaultfd), DENY(perf_event_open),
    DENY(setuid), DENY(setgid), DENY(setreuid), DENY(setregid), DENY(setresuid), DENY(setresgid), DENY(setfsuid), DENY(setfsgid), DENY(setgroups), DENY(capset),
    DENY(mount), DENY(umount2), DENY(pivot_root), DENY(chroot), DENY(move_mount), DENY(open_tree), DENY(fsopen), DENY(fsconfig), DENY(fsmount), DENY(fspick), DENY(mount_setattr),
    DENY(clock_settime), DENY(clock_adjtime), DENY(settimeofday), DENY(adjtimex), DENY(kill), DENY(tkill),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone3, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, 5), LOAD_ARG(0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NP_THREAD_FLAGS, 0, 2),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]) + 4),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fcntl, 0, 7), LOAD_ARG(1),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_DUPFD, 4, 0), BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_DUPFD_CLOEXEC, 3, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, F_SETFD, 0, 3), LOAD_ARG(0), BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NP_ENDPOINT, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_tgkill, 0, 3), LOAD_ARG(0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)getpid(), 1, 0), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    DENY(prctl), DENY(seccomp),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
  };
  struct sock_fprog program = { .len = (unsigned short)(sizeof filter / sizeof filter[0]), .filter = filter };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return -1;
  long result = syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC, &program);
  if (result != 0) { errno = EPERM; return -1; } return 0;
#endif
}
int np_helper_seal_v1(void) {
  int type; socklen_t size = sizeof type; struct ucred peer; socklen_t peer_size = sizeof peer;
  if (getsockopt(NP_ENDPOINT, SOL_SOCKET, SO_TYPE, &type, &size) || type != SOCK_SEQPACKET || getsockopt(NP_ENDPOINT, SOL_SOCKET, SO_PEERCRED, &peer, &peer_size) || peer.pid != getppid() || peer.uid != 0 || peer.gid != 0 || fcntl(NP_ENDPOINT, F_SETFD, FD_CLOEXEC) || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) || np_helper_verify_v1()) return -1;
  return np_helper_filter_v1();
}
