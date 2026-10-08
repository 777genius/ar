#define _GNU_SOURCE
#include "original-owner.h"
#include <errno.h>
#include <inttypes.h>
#include <poll.h>
#include <stdio.h>
#include <unistd.h>
#ifndef NP_OWNER_REFUSAL_FIXTURE
static void report(const char *stage, const struct np_owner_data *d) {
  printf("{\"stage\":\"%s\",\"state\":%u,\"loss\":%u,\"committed\":%s,\"legacyRefused\":%s,\"live\":%s,\"retained\":%s,\"uncertain\":%s,\"helper\":%ld,\"anchor\":\"%" PRIu64 "\",\"preparationEnd\":\"%" PRIu64 "\",\"cleanupEnd\":\"%" PRIu64 "\",\"coldEnd\":\"%" PRIu64 "\",\"observationEnd\":\"%" PRIu64 "\",\"attemptEnd\":\"%" PRIu64 "\",\"sequence\":%" PRIu64 ",\"effects\":0}\n",
    stage, (unsigned)d->state, (unsigned)d->loss, d->committed ? "true" : "false", d->legacy_refused ? "true" : "false", d->live ? "true" : "false", d->retained ? "true" : "false", d->uncertain ? "true" : "false", (long)d->helper,
    d->anchor, d->preparation_end, d->cleanup_end, d->cold_end, d->observation_end, d->attempt_end, d->sequence);
  (void)fflush(stdout);
}
int main(int argc, char **argv) {
  (void)argv;
  /* No public mode, executable, argv, environment, FD, UID or source selector. */
  if (argc != 1) return 64;
  struct np_original_owner *owner = NULL; struct np_owner_data data = {0};
  if (np_original_owner_create_v1(&owner)) {
    int error = errno;
    if (owner) { (void)np_original_owner_observe_v1(owner, &data); report("refused", &data); (void)np_original_owner_dispose_v1(owner); }
    else printf("{\"stage\":\"refused\",\"effects\":0,\"error\":%d}\n", error);
    return 77;
  }
  if (np_original_owner_launch_v1(owner)) goto close;
  for (;;) {
    if (np_original_owner_observe_v1(owner, &data)) goto close;
    if (data.committed) break;
  }
  report("committed", &data);
  while (np_original_owner_observe_v1(owner, &data) == 0) { /* original bounded protocol */ }
close:
  (void)np_original_owner_observe_v1(owner, &data); report("closed", &data);
  np_original_owner_close_v1(owner);
  np_original_owner_close_v1(owner);
  (void)np_original_owner_observe_v1(owner, &data); report("closed-again", &data);
  while (np_original_owner_join_v1(owner)) {
    if (errno != EAGAIN) { report("unresolved", &data); return 1; }
    (void)poll(NULL, 0, 10);
  }
  /* Original child wait is explicitly distinct from resource retirement. */
  report("joined", &data);
  return np_original_owner_dispose_v1(owner) ? 1 : 0;
}
#else
/* Separate source-test executable. It creates only owned silent endpoints and
 * original fixture children; the production entry has no selector or hook. */
#include <stdlib.h>
#include <fcntl.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#ifndef NP_OWNER_TEST_SCRIPT
#error NP_OWNER_TEST_SCRIPT must name the emitted source contract fixture
#endif
#ifndef NP_OWNER_NODE
#error NP_OWNER_NODE must name the held source-check Node input
#endif
#ifndef NP_OWNER_ADDON
#error NP_OWNER_ADDON must name the emitted source-check addon
#endif
static void refusal_node(int endpoint) {
  if (endpoint != NP_ENDPOINT && dup3(endpoint, NP_ENDPOINT, 0) < 0) _exit(120);
  if (endpoint != NP_ENDPOINT) close(endpoint);
  if (fcntl(NP_ENDPOINT, F_SETFD, 0)) _exit(120);
  char *const args[] = { "node", NP_OWNER_TEST_SCRIPT, "addon-refusal-child", NP_OWNER_ADDON, NULL };
  char *const env[] = { "PATH=/usr/bin:/bin", NULL };
  execve(NP_OWNER_NODE, args, env); _exit(121);
}
int main(int argc, char **argv) {
  if (argc != 2 || (strcmp(argv[1], "silent") && strcmp(argv[1], "wrong-peer"))) return 64;
  int pair[2]; if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, pair)) return 1;
  pid_t launcher = fork();
  if (launcher < 0) { close(pair[0]); close(pair[1]); return 1; }
  if (launcher == 0) {
    close(pair[0]);
    if (!strcmp(argv[1], "silent")) refusal_node(pair[1]);
    pid_t child = fork();
    if (child == 0) refusal_node(pair[1]);
    close(pair[1]); int status;
    if (child < 0 || waitpid(child, &status, 0) != child || !WIFEXITED(status)) _exit(122);
    _exit(WEXITSTATUS(status));
  }
  close(pair[1]);
  int pidfd = (int)syscall(SYS_pidfd_open, launcher, 0);
  struct pollfd original = { .fd = pidfd, .events = POLLIN };
  bool timed_out = pidfd < 0 || poll(&original, 1, 3000) != 1;
  /* On old blocked startup, close only this fixture's endpoint to obtain
   * natural child/wait/pipe settlement, and preserve the timed-out RED result. */
  (void)shutdown(pair[0], SHUT_RDWR); close(pair[0]);
  int status; pid_t joined;
  do { joined = waitpid(launcher, &status, 0); } while (joined < 0 && errno == EINTR);
  if (pidfd >= 0) close(pidfd);
  bool success = joined == launcher && WIFEXITED(status) && WEXITSTATUS(status) == 0;
  printf("{\"stage\":\"refusal-fixture\",\"timedOut\":%s,\"peerOwner\":%ld,\"launcher\":%ld,\"childJoined\":%s,\"socketClosed\":true}\n", timed_out ? "true" : "false", (long)getpid(), (long)launcher, success ? "true" : "false");
  return success && !timed_out ? 0 : 1;
}
#endif
