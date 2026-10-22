/* Finite TEST effect fixture. No mmap, submission, registration or SQPOLL. */
#define _GNU_SOURCE
#include <errno.h>
#include <linux/io_uring.h>
#include <sys/prctl.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
#if !defined(__x86_64__) || !defined(__linux__)
#error TEST_requires_Linux_x64
#endif
/* sa/sr/se, ca/cr/ce, ea/er/ee, ra/rr/re, nn/ne, sc/se2. */
static int control_failure(const long f[16]) {
  printf("TEST_uring_control_failure_v1 %ld %ld %ld %ld %ld %ld %ld %ld "
    "%ld %ld %ld %ld %ld %ld %ld %ld\n", f[0], f[1], f[2], f[3],
    f[4], f[5], f[6], f[7], f[8], f[9], f[10], f[11], f[12], f[13], f[14], f[15]);
  return 70;
}
static int observe(int control) {
  struct io_uring_params params = {0};
  long f[16] = {1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
  if (control) {
    errno = 0; f[12] = prctl(PR_GET_NO_NEW_PRIVS, 0UL, 0UL, 0UL, 0UL); f[13] = errno;
    errno = 0; f[14] = prctl(PR_GET_SECCOMP, 0UL, 0UL, 0UL, 0UL); f[15] = errno;
  }
  errno = 0; f[1] = syscall(SYS_io_uring_setup, 2u, &params); f[2] = errno;
  if (f[1] >= 0) {
    f[3] = 1; errno = 0; f[4] = close((int)f[1]); f[5] = errno;
    if (f[4] != 0) return control ? control_failure(f) : 70;
  }
  f[6] = 1; errno = 0;
  f[7] = syscall(SYS_io_uring_enter, -1, 0u, 0u, 0u, NULL, 0u); f[8] = errno;
  f[9] = 1; errno = 0;
  /* -1 is the blind-registration sentinel; -2 uses ordinary invalid-fd lookup. */
  f[10] = syscall(SYS_io_uring_register, (unsigned int)-2, 0u, NULL, 0u); f[11] = errno;
  if (control) {
    if (f[1] >= 0 && f[7] == -1 && f[8] == EBADF && f[10] == -1 && f[11] == EBADF) return 0;
    return control_failure(f);
  }
  return f[1] == -1 && f[2] == ENOSYS && f[7] == -1 && f[8] == ENOSYS &&
    f[10] == -1 && f[11] == ENOSYS ? 0 : 70;
}
int main(int argc, char **argv) {
  if (argc != 2) return 70;
  int control = strcmp(argv[1], "control") == 0;
  int child = strcmp(argv[1], "exec-child") == 0;
  if (!control && !child && strcmp(argv[1], "deny") != 0) return 70;
  if (observe(control)) return 70;
  if (puts(control ? "TEST_uring_control" : child ? "TEST_uring_exec_denied" :
      "TEST_uring_denied") == EOF || fflush(stdout)) return 70;
  if (control || child) return 0;
  char release;
  if (read(STDIN_FILENO, &release, 1) != 1 || release != 'x') return 70;
  if (observe(0) || puts("TEST_uring_denied") == EOF || fflush(stdout)) return 70;
  pid_t pid = fork();
  if (pid < 0) return 70;
  if (pid == 0) {
    execl("/proc/self/exe", "TEST-io-uring-probe", "exec-child", (char *)NULL);
    _exit(70);
  }
  int status;
  if (waitpid(pid, &status, 0) != pid || !WIFEXITED(status)) return 70;
  return WEXITSTATUS(status);
}
