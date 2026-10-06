/* Finite TEST effect fixture. No mmap, submission, registration or SQPOLL. */
#define _GNU_SOURCE
#include <errno.h>
#include <linux/io_uring.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
#if !defined(__x86_64__) || !defined(__linux__)
#error TEST_requires_Linux_x64
#endif
static int observe(int control) {
  struct io_uring_params params = {0};
  errno = 0;
  long setup = syscall(SYS_io_uring_setup, 2u, &params);
  int setup_errno = errno;
  if (setup >= 0 && close((int)setup) != 0) return 70;
  errno = 0;
  long enter = syscall(SYS_io_uring_enter, -1, 0u, 0u, 0u, NULL, 0u);
  int enter_errno = errno;
  errno = 0;
  long reg = syscall(SYS_io_uring_register, -1, 0u, NULL, 0u);
  int reg_errno = errno;
  if (control)
    return setup >= 0 && enter == -1 && enter_errno == EBADF &&
      reg == -1 && reg_errno == EBADF ? 0 : 70;
  return setup == -1 && setup_errno == ENOSYS && enter == -1 &&
    enter_errno == ENOSYS && reg == -1 && reg_errno == ENOSYS ? 0 : 70;
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
