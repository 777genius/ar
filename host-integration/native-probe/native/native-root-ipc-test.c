#define _GNU_SOURCE
#include "native-root-control.h"
#include "mechanisms.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
_Static_assert(sizeof NP_ROOT_SOCKET <= sizeof ((struct sockaddr_un *)0)->sun_path, "fixed DATA socket path exceeds AF_UNIX capacity");
#ifndef NP_ROOT_TEST_CLIENT
#error "DATA IPC fixture requires build-bound disposable client"
#endif
/* A real disposable DATA peer. No native owner, seal or admission is minted. */
int main(int argc, char **argv) {
  if (argc != 2 || (strcmp(argv[1], "data") && strcmp(argv[1], "rights") && strcmp(argv[1], "correlation") && strcmp(argv[1], "short") && strcmp(argv[1], "eof") && strcmp(argv[1], "delay") && strcmp(argv[1], "peer") && strcmp(argv[1], "version") && strcmp(argv[1], "extra") && strcmp(argv[1], "backpressure") && strcmp(argv[1], "utf8") && strcmp(argv[1], "magic"))) return 77;
  struct np_directory directory;
  if (getuid() || geteuid() || getgid() || getegid() || np_directory_pin_v1(&directory, NP_ROOT_DIRECTORY)) return 78;
  unsigned char request[150]; size_t length = fread(request, 1, sizeof request, stdin);
  struct np_root_request_v3 decoded; if (ferror(stdin) || np_root_request_decode_v3(request, length, &decoded)) return 77;
  int listener = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0), incoming[2], outgoing[2];
  struct sockaddr_un address = { .sun_family = AF_UNIX }; memcpy(address.sun_path, NP_ROOT_SOCKET, sizeof NP_ROOT_SOCKET);
  if (listener < 0 || np_directory_check_v1(&directory) || bind(listener, (struct sockaddr *)&address, sizeof address) || chmod(NP_ROOT_SOCKET, 0600) || listen(listener, 1) || pipe2(incoming, O_CLOEXEC) || pipe2(outgoing, O_CLOEXEC)) return 77;
  if (!strcmp(argv[1], "backpressure") && (fcntl(outgoing[1], F_SETPIPE_SZ, 4096) != 4096 || fcntl(outgoing[1], F_GETPIPE_SZ) != 4096)) return 77;
  struct stat owned; if (lstat(NP_ROOT_SOCKET, &owned) || !S_ISSOCK(owned.st_mode)) return 77;
  pid_t child = fork();
  if (!child) {
    if (dup2(incoming[0], 0) < 0 || dup2(outgoing[1], 1) < 0) _exit(77);
    close(incoming[0]); close(incoming[1]); close(outgoing[0]); close(outgoing[1]); close(listener);
    char *const args[] = { "native-root-client", NULL }, *const env[] = { "PATH=/usr/bin:/bin", NULL };
    execve(NP_ROOT_TEST_CLIENT, args, env); _exit(77);
  }
  if (child < 0) return 77;
  close(incoming[0]); close(outgoing[1]);
  if (write(incoming[1], request, length) != (ssize_t)length || close(incoming[1])) return 77;
  struct pollfd pending = { .fd = listener, .events = POLLIN };
  if (poll(&pending, 1, 2200) <= 0) return 77;
  int connection = accept4(listener, NULL, NULL, SOCK_CLOEXEC); if (connection < 0) return 77;
  unsigned char received[150]; ssize_t n = recv(connection, received, sizeof received, MSG_TRUNC);
  if (n != (ssize_t)length || memcmp(received, request, length)) return 77;
  unsigned char response[NP_ROOT_WIRE_MAX]; size_t response_length = !strcmp(argv[1], "backpressure") ? sizeof response : !strcmp(argv[1], "utf8") ? 32 : 33;
  if (np_root_response_header_v3(response, &decoded, 0, response_length - NP_ROOT_WIRE_HEADER)) return 77;
  if (!strcmp(argv[1], "utf8")) { memcpy(response + NP_ROOT_WIRE_HEADER, "{\"data\":\"", 9); response[29] = 0xff; memcpy(response + 30, "\"}", 2); }
  else if (response_length == 33) memcpy(response + NP_ROOT_WIRE_HEADER, "{\"data\":true}", 13);
  else { memcpy(response + NP_ROOT_WIRE_HEADER, "{\"data\":\"", 9); memset(response + NP_ROOT_WIRE_HEADER + 9, 'a', response_length - NP_ROOT_WIRE_HEADER - 11); memcpy(response + response_length - 2, "\"}", 2); }
  if (!strcmp(argv[1], "delay")) { struct pollfd idle = { .fd = connection, .events = 0 }; (void)poll(&idle, 1, 2100); }
  else if (strcmp(argv[1], "eof")) {
    if (!strcmp(argv[1], "peer")) {
      pid_t foreign = fork();
      if (!foreign) { int sent = send(connection, response, response_length, MSG_NOSIGNAL) == (ssize_t)response_length; close(connection); close(outgoing[0]); _exit(sent ? 0 : 77); }
      int settled; if (foreign < 0 || waitpid(foreign, &settled, 0) != foreign || !WIFEXITED(settled) || WEXITSTATUS(settled)) return 77;
    }
    if (!strcmp(argv[1], "magic")) response[0] |= 0x80;
    if (!strcmp(argv[1], "version")) response[4] = 2;
    if (!strcmp(argv[1], "extra")) response[7] = 1;
    if (!strcmp(argv[1], "correlation")) response[19] ^= 1;
    size_t bytes = !strcmp(argv[1], "short") ? 19 : response_length;
    if (!strcmp(argv[1], "rights")) {
      int fd = open("/dev/null", O_RDONLY | O_CLOEXEC); if (fd < 0) return 77;
      union { struct cmsghdr align; unsigned char bytes[CMSG_SPACE(sizeof(int))]; } control;
      memset(&control, 0, sizeof control); struct iovec iov = { .iov_base = response, .iov_len = bytes };
      struct msghdr message = { .msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof control.bytes };
      struct cmsghdr *c = CMSG_FIRSTHDR(&message); c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int)); memcpy(CMSG_DATA(c), &fd, sizeof fd);
      if (sendmsg(connection, &message, MSG_NOSIGNAL) != (ssize_t)bytes) return 77;
      close(fd);
    } else if (strcmp(argv[1], "peer") && send(connection, response, bytes, MSG_NOSIGNAL) != (ssize_t)bytes) return 77;
  }
  close(connection); close(listener);
  if (!strcmp(argv[1], "backpressure")) (void)poll(NULL, 0, 2400);
  unsigned char output[NP_ROOT_WIRE_MAX]; size_t used = 0;
  for (;;) { ssize_t count = read(outgoing[0], output + used, sizeof output - used); if (count < 0 && errno == EINTR) continue; if (count < 0 || used == sizeof output) return 77; if (!count) break; used += (size_t)count; }
  close(outgoing[0]); int status;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) return 77;
  struct stat current; if (np_directory_check_v1(&directory) || lstat(NP_ROOT_SOCKET, &current) || current.st_dev != owned.st_dev || current.st_ino != owned.st_ino || unlink(NP_ROOT_SOCKET)) return 77;
  np_directory_release_v1(&directory);
  if (!strcmp(argv[1], "utf8")) return WEXITSTATUS(status) == 0 && used == response_length && !memcmp(output, response, used) && fwrite(output, 1, used, stdout) == used ? 0 : 77;
  if (!strcmp(argv[1], "data")) return WEXITSTATUS(status) == 0 && used == response_length && !memcmp(output, response, used) ? 0 : 77;
  if (!strcmp(argv[1], "backpressure")) return WEXITSTATUS(status) == 77 && used > 0 && used < response_length ? 0 : 77;
  return WEXITSTATUS(status) == 77 && !used ? 0 : 77;
}
