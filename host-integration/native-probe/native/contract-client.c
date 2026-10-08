#define _GNU_SOURCE
#include "mechanisms.h"
#include "resources.h"
#include "stock-manager.h"
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
static void require(int condition, const char *what) { if (!condition) { fprintf(stderr, "contract client: %s (%d)\n", what, errno); exit(2); } }
static struct np_frame frame(uint64_t sequence) { return (struct np_frame){ .magic = NP_FRAME_MAGIC, .version = 1, .kind = NP_HELLO, .generation = 42, .sequence = sequence }; }
static void send_right(int fd) {
  int harmless = open("/dev/null", O_RDONLY | O_CLOEXEC); require(harmless >= 0, "owned harmless descriptor");
  struct np_frame f = frame(1); struct iovec iov = { .iov_base = &f, .iov_len = sizeof f };
  union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int))]; } control;
  memset(&control, 0, sizeof control);
  struct msghdr msg = { .msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof control.bytes };
  struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int)); memcpy(CMSG_DATA(c), &harmless, sizeof harmless);
  require(sendmsg(fd, &msg, 0) == (ssize_t)sizeof f, "fixture rights send"); close(harmless);
}
static const char *self_image;
static void helper_frame(const char *mode) {
  require(fcntl(NP_ENDPOINT, F_SETFD, FD_CLOEXEC) == 0, "trusted post-exec endpoint seal");
  require((fcntl(NP_ENDPOINT, F_GETFD) & FD_CLOEXEC) != 0, "restored endpoint close-on-exec");
  char ready; require(read(NP_ENDPOINT, &ready, 1) == 1, "parent pin synchronization");
  struct np_frame f = frame(1);
  if (!strcmp(mode, "foreign")) {
    pid_t foreign = fork(); require(foreign >= 0, "disposable foreign child");
    if (!foreign) { require(write(NP_ENDPOINT, &f, sizeof f) == (ssize_t)sizeof f, "foreign kernel credentials"); _exit(0); }
    require(waitpid(foreign, NULL, 0) == foreign, "foreign fixture reap");
  } else if (!strcmp(mode, "rights")) send_right(NP_ENDPOINT);
  else if (!strcmp(mode, "truncated")) { char bytes[64] = {0}; require(write(NP_ENDPOINT, bytes, sizeof bytes) == (ssize_t)sizeof bytes, "oversized packet"); }
  else { require(write(NP_ENDPOINT, &f, sizeof f) == (ssize_t)sizeof f, "original kernel credentials"); if (!strcmp(mode, "duplicate")) require(write(NP_ENDPOINT, &f, sizeof f) == (ssize_t)sizeof f, "duplicate packet"); }
  require(read(NP_ENDPOINT, &ready, 1) == 1, "bounded fixture completion"); _exit(0);
}
static int channel_test(const char *mode) {
  struct np_clock clock; require(np_clock_pin_v1(&clock) == 0, "original clock pins");
  struct np_channel channel; require(np_channel_create_v1(&channel, 42) == 0, "real seqpacket pair");
  struct stat helper_identity; require(fstat(channel.helper, &helper_identity) == 0, "original sending endpoint identity");
  pid_t child = fork(); require(child >= 0, "original child");
  if (!child) {
    require(prctl(PR_SET_PDEATHSIG, SIGKILL) == 0, "fixture parent lifetime");
    require(np_channel_child_inherit_v1(&channel) == 0, "single fixed exec inheritance");
    char *const args[] = { (char *)self_image, "helper", (char *)mode, NULL };
    char *const environment[] = { NULL };
    execve(self_image, args, environment); _exit(2);
  }
  require(np_channel_parent_bind_v1(&channel, child, getuid(), getgid()) == 0, "original pidfd association");
  DIR *descriptors = opendir("/proc/self/fd"); require(descriptors != NULL, "independent parent endpoint census");
  struct dirent *entry;
  while ((entry = readdir(descriptors))) {
    char *end = NULL; long candidate = strtol(entry->d_name, &end, 10);
    if (!end || *end || candidate < 0 || candidate > 65536) continue;
    struct stat actual;
    if (fstat((int)candidate, &actual) == 0) require(actual.st_dev != helper_identity.st_dev || actual.st_ino != helper_identity.st_ino, "parent retains no sending endpoint alias");
  }
  closedir(descriptors);
  require(np_birth_associate_v1(&clock, &channel.birth) == 0, "time/time_for_children association");
  require(write(channel.owner, "r", 1) == 1, "pinned child release");
  struct pollfd p = { .fd = channel.owner, .events = POLLIN }; require(poll(&p, 1, 1000) == 1, "bounded original observation");
  struct np_frame f; int result = np_channel_receive_v1(&channel, &f), second = 0;
  if (!strcmp(mode, "duplicate")) { require(poll(&p, 1, 1000) == 1, "duplicate observation"); second = np_channel_receive_v1(&channel, &f); }
  int live = np_birth_live_v1(&channel.birth) == 0;
  printf("{\"accepted\":%s,\"secondRejected\":%s,\"lost\":%s,\"live\":%s,\"sequence\":%llu}\n", result == 0 ? "true" : "false", second < 0 ? "true" : "false", channel.lost ? "true" : "false", live ? "true" : "false", (unsigned long long)channel.sequence);
  require(write(channel.owner, "x", 1) == 1, "owned fixture close"); require(waitpid(child, NULL, 0) == child, "original fixture reap");
  np_channel_release_v1(&channel); np_clock_release_v1(&clock); return 0;
}
static int forgery_test(void) {
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 }; struct __user_cap_data_struct caps[2];
  require(syscall(SYS_capget, &header, caps) == 0 && !caps[0].effective && !caps[1].effective, "capability-free fixture required");
  int pair[2]; require(socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, pair) == 0, "forgery fixture pair");
  char byte = 'x'; struct iovec iov = { .iov_base = &byte, .iov_len = 1 };
  union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(struct ucred))]; } control; memset(&control, 0, sizeof control);
  struct msghdr msg = { .msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof control.bytes };
  struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_CREDENTIALS; c->cmsg_len = CMSG_LEN(sizeof(struct ucred));
  struct ucred false_identity = { .pid = getppid(), .uid = getuid(), .gid = getgid() }; memcpy(CMSG_DATA(c), &false_identity, sizeof false_identity);
  ssize_t result = sendmsg(pair[0], &msg, 0); int error = errno;
  printf("{\"kernelRejected\":%s,\"error\":%d}\n", result < 0 && error == EPERM ? "true" : "false", error);
  close(pair[0]); close(pair[1]); return 0;
}
static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t condition = PTHREAD_COND_INITIALIZER;
static int release_thread, inherited_refusal;
static void *existing_thread(void *unused) {
  (void)unused; require(pthread_mutex_lock(&mutex) == 0, "thread lock");
  while (!release_thread) require(pthread_cond_wait(&condition, &mutex) == 0, "thread wait");
  require(pthread_mutex_unlock(&mutex) == 0, "thread unlock");
  inherited_refusal = syscall(SYS_fork) < 0 && errno == EPERM; return NULL;
}
static void *new_thread(void *unused) { (void)unused; return (void *)(uintptr_t)(syscall(SYS_fork) < 0 && errno == EPERM); }
static int filter_test(void) {
  pthread_t old, fresh; require(pthread_create(&old, NULL, existing_thread, NULL) == 0, "inventoried preexisting thread");
  require(np_helper_filter_v1() == 0, "actual synchronized filter");
  errno = 0; int clone3_refused = syscall(SYS_clone3, NULL, 0) < 0 && errno == ENOSYS;
  int fork_refused = syscall(SYS_fork) < 0 && errno == EPERM;
  int dup_refused = syscall(SYS_dup, STDOUT_FILENO) < 0 && errno == EPERM;
  int fcntl_refused = fcntl(STDOUT_FILENO, F_DUPFD, 10) < 0 && errno == EPERM && fcntl(STDOUT_FILENO, F_DUPFD_CLOEXEC, 10) < 0 && errno == EPERM;
  int namespace_refused = syscall(SYS_unshare, 0) < 0 && errno == EPERM;
  int export_refused = syscall(SYS_sendmsg, -1, NULL, 0) < 0 && errno == EPERM;
  int flags_refused = fcntl(NP_ENDPOINT, F_SETFD, 0) < 0 && errno == EPERM;
  require(pthread_mutex_lock(&mutex) == 0, "release lock"); release_thread = 1; require(pthread_cond_signal(&condition) == 0, "release thread"); require(pthread_mutex_unlock(&mutex) == 0, "release unlock");
  require(pthread_join(old, NULL) == 0, "existing thread join");
  require(pthread_create(&fresh, NULL, new_thread, NULL) == 0, "checked libc pthread fallback"); void *new_refusal = NULL; require(pthread_join(fresh, &new_refusal) == 0, "new thread join");
  printf("{\"clone3\":%s,\"fork\":%s,\"dup\":%s,\"fcntl\":%s,\"namespace\":%s,\"export\":%s,\"flags\":%s,\"existingThread\":%s,\"newThread\":%s}\n", clone3_refused ? "true" : "false", fork_refused ? "true" : "false", dup_refused ? "true" : "false", fcntl_refused ? "true" : "false", namespace_refused ? "true" : "false", export_refused ? "true" : "false", flags_refused ? "true" : "false", inherited_refusal ? "true" : "false", new_refusal ? "true" : "false"); return 0;
}
static int publication_test(const char *mode, const char *root) {
  char path[4096]; struct np_directory stage, final;
  require(snprintf(path, sizeof path, "%s/staging", root) > 0, "staging fixture path");
  int stage_result = np_directory_pin_v1(&stage, path);
  if (!strcmp(mode, "symlink")) { printf("{\"refused\":%s}\n", stage_result < 0 ? "true" : "false"); if (!stage_result) np_directory_release_v1(&stage); return 0; }
  require(stage_result == 0, "protected staging ancestry");
  require(snprintf(path, sizeof path, "%s/units", root) > 0, "final fixture path"); require(np_directory_pin_v1(&final, path) == 0, "protected final ancestry");
  struct np_clock clock; require(np_clock_pin_v1(&clock) == 0, "publication clock domain");
  struct np_gate gate = { .clock = &clock, .cutoff = clock.preparation_end };
  const char locator[] = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  struct np_publication publication; require(np_fragment_init_v1(&publication, &stage, &final, locator) == 0, "deterministic fragment");
  if (!strcmp(mode, "partial")) { struct rlimit limit = { .rlim_cur = 128, .rlim_max = 128 }; require(signal(SIGXFSZ, SIG_IGN) != SIG_ERR && setrlimit(RLIMIT_FSIZE, &limit) == 0, "real bounded write fault"); }
  if (!strcmp(mode, "expired")) { gate.cutoff = clock.anchor + 1000000; usleep(5000); }
  int result = np_fragment_publish_v1(&publication, &gate), error = errno; struct stat held = {0};
  if (publication.file >= 0) require(fstat(publication.file, &held) == 0, "original inode remains held");
  printf("{\"published\":%s,\"stage\":%d,\"uncertain\":%s,\"inode\":%llu,\"device\":%llu,\"size\":%lld,\"error\":%d}\n", result == 0 ? "true" : "false", publication.stage, publication.uncertain ? "true" : "false", (unsigned long long)held.st_ino, (unsigned long long)held.st_dev, (long long)held.st_size, error); fflush(stdout);
  char command; require(read(STDIN_FILENO, &command, 1) == 1, "fixture owned custody observation");
  if (command == 'v') { int verified = np_fragment_verify_v1(&publication); require(fstat(publication.file, &held) == 0, "original inode after replacement"); printf("{\"verified\":%s,\"inode\":%llu,\"links\":%llu}\n", verified == 0 ? "true" : "false", (unsigned long long)held.st_ino, (unsigned long long)held.st_nlink); }
  else { int retry = np_fragment_publish_v1(&publication, &gate); printf("{\"repeated\":%s,\"error\":%d}\n", retry == 0 ? "true" : "false", errno); }
  np_publication_release_v1(&publication); np_directory_release_v1(&stage); np_directory_release_v1(&final); np_clock_release_v1(&clock); return 0;
}
static int clock_test(void) {
  struct np_clock clock; require(np_clock_pin_v1(&clock) == 0, "retained clock namespaces"); uint64_t anchor = clock.anchor, before, after;
  require(np_clock_sample_v1(&clock, &before) == 0, "original high water"); usleep(20000); require(np_clock_sample_v1(&clock, &after) == 0, "charged delay");
  printf("{\"anchor\":%llu,\"preparationEnd\":%llu,\"cleanupEnd\":%llu,\"elapsed\":%llu,\"unchanged\":%s}\n", (unsigned long long)anchor, (unsigned long long)clock.preparation_end, (unsigned long long)clock.cleanup_end, (unsigned long long)(after - before), clock.anchor == anchor ? "true" : "false"); np_clock_release_v1(&clock); return 0;
}
static int node_contract(const char *node, const char *script, const char *addon) {
  struct np_clock clock; require(np_clock_pin_v1(&clock) == 0, "Node original clock");
  struct np_channel channel; require(np_channel_create_v1(&channel, 42) == 0, "Node original endpoint");
  pid_t child = fork(); require(child >= 0, "single Node contract birth");
  if (!child) {
    require(prctl(PR_SET_PDEATHSIG, SIGKILL) == 0 && np_channel_child_inherit_v1(&channel) == 0, "Node fixed endpoint inheritance");
    require(np_helper_preexec_filter_v1() == 0, "Node original pre-exec restriction");
    errno = 0; require(syscall(SYS_io_uring_setup, 0U, NULL) < 0 && errno == EPERM, "pre-exec io_uring_setup refusal");
    errno = 0; require(syscall(SYS_io_uring_enter, -1, 0U, 0U, 0U, NULL, 0U) < 0 && errno == EPERM, "pre-exec io_uring_enter refusal");
    errno = 0; require(syscall(SYS_io_uring_register, -1, 0U, NULL, 0U) < 0 && errno == EPERM, "pre-exec io_uring_register refusal");
    char *const arguments[] = { (char *)node, (char *)script, (char *)addon, NULL };
    char *const environment[] = { NULL };
    execve(node, arguments, environment); _exit(2);
  }
  require(np_channel_parent_bind_v1(&channel, child, getuid(), getgid()) == 0 && np_birth_associate_v1(&clock, &channel.birth) == 0, "original Node birth pin");
  require(write(channel.owner, "r", 1) == 1, "Node pin synchronization");
  struct pollfd event = { .fd = channel.owner, .events = POLLIN };
  require(poll(&event, 1, 4000) == 1, "Node bounded original observation");
  struct np_frame original; require(np_channel_receive_v1(&channel, &original) == 0 && original.kind == NP_HELLO, "actual sealed Node channel frame");
  require(write(channel.owner, "x", 1) == 1, "Node fixture completion");
  int status; require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0, "Node clean owned exit");
  np_channel_release_v1(&channel); np_clock_release_v1(&clock); return 0;
}
static int resource_refusal(const char *root) {
  int origin = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); require(origin >= 0, "owned non-cgroup fixture");
  struct np_resource_view view;
  int result = np_resource_view_pin_v1(&view, origin);
  printf("{\"refused\":%s,\"originalDescriptorRetained\":%s,\"resourceExposed\":%s}\n", result < 0 ? "true" : "false", fcntl(origin, F_GETFD) >= 0 ? "true" : "false", view.original_delegation >= 0 ? "true" : "false");
  np_resource_view_release_v1(&view); close(origin); return 0;
}
static int manager_refusal(void) {
  int pair[2], guard[2]; require(socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) == 0 && pipe2(guard, O_CLOEXEC) == 0, "owned private bus fixture");
  pid_t child = fork(); require(child >= 0, "owned expected-manager fixture birth");
  if (!child) { close(guard[1]); close(pair[0]); close(pair[1]); char byte; (void)read(guard[0], &byte, 1); _exit(0); }
  close(guard[0]);
  struct np_clock clock; struct np_birth birth;
  require(np_clock_pin_v1(&clock) == 0 && np_birth_pin_v1(&birth, child, 0, 0) == 0, "original fixture manager pins");
  struct np_gate gate = { .clock = &clock, .cutoff = clock.preparation_end };
  struct np_stock_manager *manager = NULL;
  int result = np_manager_connect_v1(&manager, pair[0], &birth, &gate, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 42, 32);
  char byte; errno = 0; ssize_t received = recv(pair[1], &byte, 1, MSG_DONTWAIT);
  bool no_traffic = received < 0 && (errno == EAGAIN || errno == EWOULDBLOCK);
  printf("{\"refused\":%s,\"noAuthenticationTraffic\":%s,\"originalSocketRetained\":%s,\"managerBirthLive\":%s}\n", result < 0 && manager == NULL ? "true" : "false", no_traffic ? "true" : "false", fcntl(pair[0], F_GETFD) >= 0 ? "true" : "false", np_birth_live_v1(&birth) == 0 ? "true" : "false");
  np_manager_release_v1(manager); np_birth_release_v1(&birth); np_clock_release_v1(&clock);
  require(write(guard[1], "x", 1) == 1 && waitpid(child, NULL, 0) == child, "owned fixture completion");
  close(guard[1]); close(pair[0]); close(pair[1]); return 0;
}
static int nondumpable_association(void) {
  int release[2], sealed[2]; require(pipe2(release, O_CLOEXEC) == 0 && pipe2(sealed, O_CLOEXEC) == 0, "owned sealing fixture synchronization");
  struct np_clock clock; require(np_clock_pin_v1(&clock) == 0, "original sealing fixture clock");
  pid_t child = fork(); require(child >= 0, "original sealing fixture birth");
  if (!child) {
    close(release[1]); close(sealed[0]); char byte;
    require(read(release[0], &byte, 1) == 1 && prctl(PR_SET_DUMPABLE, 0) == 0, "actual nondumpable child seal");
    require(write(sealed[1], "s", 1) == 1 && read(release[0], &byte, 1) == 1, "original fixture observation lifetime"); _exit(0);
  }
  close(release[0]); close(sealed[1]);
  struct np_birth birth; require(np_birth_pin_v1(&birth, child, getuid(), getgid()) == 0 && np_birth_associate_v1(&clock, &birth) == 0, "pre-seal original namespace association");
  require(write(release[1], "r", 1) == 1, "original child release"); char byte; require(read(sealed[0], &byte, 1) == 1, "observed actual child seal");
  int association = np_birth_associate_v1(&clock, &birth);
  struct stat time, children; bool retained = fstat(birth.time, &time) == 0 && fstat(birth.children, &children) == 0 && time.st_dev == children.st_dev && time.st_ino == children.st_ino;
  printf("{\"procRevalidationRefused\":%s,\"originalBirthLive\":%s,\"originalNamespacesRetained\":%s}\n", association < 0 ? "true" : "false", np_birth_live_v1(&birth) == 0 ? "true" : "false", retained ? "true" : "false");
  require(write(release[1], "x", 1) == 1 && waitpid(child, NULL, 0) == child, "owned sealing fixture exit");
  close(release[1]); close(sealed[0]); np_birth_release_v1(&birth); np_clock_release_v1(&clock); return 0;
}
int main(int argc, char **argv) {
  require(argc >= 2, "fixture mode required"); self_image = argv[0];
  // Disposable clients explicitly establish empty capability sets even on a
  // container runner. This is not the fixed-identity production helper profile.
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct empty[2] = { {0}, {0} };
  require(syscall(SYS_capset, &header, empty) == 0 && prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0, "capability-free owned fixture");
  if (!strcmp(argv[1], "helper")) { require(argc == 3, "fixed helper frame kind"); helper_frame(argv[2]); }
  if (!strcmp(argv[1], "node-contract")) { require(argc == 5, "fixed Node contract closure"); return node_contract(argv[2], argv[3], argv[4]); }
  if (!strcmp(argv[1], "resource-refusal")) { require(argc == 3, "owned filesystem fixture"); return resource_refusal(argv[2]); }
  if (!strcmp(argv[1], "manager-refusal")) return manager_refusal();
  if (!strcmp(argv[1], "nondumpable")) return nondumpable_association();
  if (!strcmp(argv[1], "clock")) return clock_test();
  if (!strcmp(argv[1], "forgery")) return forgery_test();
  if (!strcmp(argv[1], "filter")) return filter_test();
  if (!strcmp(argv[1], "profile")) { printf("{\"refused\":%s}\n", np_helper_verify_v1() < 0 ? "true" : "false"); return 0; }
  if (!strcmp(argv[1], "channel")) { require(argc == 3, "channel mode"); return channel_test(argv[2]); }
  require(argc == 3, "publication fixture root"); return publication_test(argv[1], argv[2]);
}
