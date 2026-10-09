#define _GNU_SOURCE
#include "stock-manager.h"
#include "stock-bus-abi.h"
#ifdef NP_RETAINED_V2_B1A
#include "retained-v2-actors.h"
#include "root-managed-launch.h"
#endif
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#define MANAGER_PATH "/org/freedesktop/systemd1"
#define MANAGER_INTERFACE "org.freedesktop.systemd1.Manager"
#define UNIT_INTERFACE "org.freedesktop.systemd1.Unit"
struct retained_call {
  struct np_stock_manager *owner;
  enum np_manager_step step;
  sd_bus_message *request, *reply;
  sd_bus_slot *slot;
};
struct retained_job { uint32_t id; char path[128], unit[128], outcome[32]; uint64_t event; bool associated; sd_bus_message *original; };
struct np_stock_manager {
  sd_bus *bus; sd_bus_slot *filter;
  struct np_birth birth;
  struct np_gate *gate;
  struct np_manager_observation observation;
  struct retained_call calls[NP_MANAGER_STEPS];
  struct retained_job *jobs;
  sd_bus_message **incoming;
  size_t job_count, capacity;
  char slice[128], target[128], slice_path[512], target_path[512];
  sd_bus_message *reload_events[2];
  struct np_publication *fragment;
  struct np_resource_pair *pair;
#ifdef NP_RETAINED_V2_B1A
  struct np_actor_event_debt actor_debt;
  const struct np_actor_manager *actor_connection;
  uint64_t actor_events;
  bool actor_observer_armed;
  struct np_root_origin *reference_origin;struct np_managed_original *references;
#endif
};
static const char *const methods[NP_MANAGER_STEPS] = {
  "GetUnit", "Subscribe", "StartTransientUnit", "RefUnit", "GetAll", "GetAll", "Reload", "GetAll",
#ifdef NP_RETAINED_V2_A1
  "GetAll",
#endif
  "LoadUnit", "RefUnit", "GetAll", "StartUnit", "GetAll", "GetAll",
#ifdef NP_RETAINED_V2_A1
  "GetAll",
#endif
};
static int failed(struct np_stock_manager *manager, int error) {
  manager->observation.lost = true; manager->gate->closed = true; errno = error; return -1;
}
static int copy(char *to, size_t capacity, const char *from) {
  if (!from || strlen(from) >= capacity) { errno = EOVERFLOW; return -1; }
  memcpy(to, from, strlen(from) + 1); return 0;
}
static int path(char *to, size_t capacity, const char *unit) {
  size_t at = strlen(MANAGER_PATH "/unit/");
  if (capacity <= at) return -1;
  memcpy(to, MANAGER_PATH "/unit/", at);
  for (const unsigned char *p = (const unsigned char *)unit; *p; p++) {
    if ((*p >= 'A' && *p <= 'Z') || (*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9')) { if (at + 1 >= capacity) return -1; to[at++] = (char)*p; }
    else { if (at + 3 >= capacity) return -1; int n = snprintf(to + at, capacity - at, "_%02x", *p); if (n != 3) return -1; at += 3; }
  }
  to[at] = 0; return 0;
}
static bool slice_property_step(enum np_manager_step step) {
  return step == NP_SLICE_CPU_FACTS
#ifdef NP_RETAINED_V2_A1
    || step == NP_SLICE_RELOAD_CPU_FACTS || step == NP_SLICE_FINAL_CPU_FACTS
#endif
    ;
}
static bool property_step(enum np_manager_step step) {
  return slice_property_step(step) || step == NP_SLICE_FACTS || step == NP_SLICE_RELOAD_FACTS || step == NP_TARGET_PRESTART_FACTS || step == NP_TARGET_FACTS || step == NP_SLICE_FINAL_FACTS;
}
static int association(struct np_stock_manager *manager) {
  if (manager->observation.lost || np_birth_associate_v1(manager->gate->clock, &manager->birth)) return failed(manager, ESTALE);
  struct ucred peer; socklen_t size = sizeof peer;
  if (getsockopt(sd_bus_get_fd(manager->bus), SOL_SOCKET, SO_PEERCRED, &peer, &size) || size != sizeof peer || peer.pid != manager->birth.pid || peer.uid != 0 || peer.gid != 0) return failed(manager, ESTALE);
  return 0;
}
static int boundary(struct np_stock_manager *manager) {
  if (manager->observation.closed || association(manager) || np_gate_check_v1(manager->gate)) { manager->observation.closed = true; return -1; } return 0;
}
static bool replied(const struct np_stock_manager *manager, enum np_manager_step step) {
  const struct np_request_observation *r = &manager->observation.requests[step]; return r->state == NP_REQUEST_REPLIED && !r->late;
}
static bool successful_job(const struct np_stock_manager *manager, enum np_manager_step step) {
  const struct np_request_observation *r = &manager->observation.requests[step]; return replied(manager, step) && r->job_reply && r->job_done && !strcmp(r->outcome, "done");
}
static int correlate(struct np_stock_manager *manager, enum np_manager_step step) {
  struct np_request_observation *request = &manager->observation.requests[step];
  if (!request->job_reply) return 0;
  const char *unit = step == NP_SLICE_START ? manager->slice : manager->target;
  for (size_t i = 0; i < manager->job_count; i++) {
    struct retained_job *event = &manager->jobs[i];
    if (event->associated || strcmp(event->path, request->job)) continue;
    if (request->job_done || event->id != request->job_id || strcmp(event->unit, unit)) return failed(manager, EPROTO);
    request->job_done = true; event->associated = true;
    if (copy(request->outcome, sizeof request->outcome, event->outcome)) return failed(manager, EPROTO);
    if (strcmp(request->outcome, "done")) { manager->observation.closed = true; manager->gate->closed = true; }
  }
  return 0;
}
static int events(sd_bus_message *message, void *data, sd_bus_error *error) {
  (void)error; struct np_stock_manager *manager = data;
  uint8_t type;
  if (sd_bus_message_get_type(message, &type) < 0) return failed(manager, EPROTO);
  if (manager->observation.events == manager->capacity) return failed(manager, ENOBUFS);
  manager->incoming[manager->observation.events++] = sd_bus_message_ref(message);
  /* Consume unexpected incoming methods. JOIN must never produce implicit
   * libsystemd method replies or a new manager request. */
  if (type == 1) { (void)failed(manager, EPROTO); return 1; }
  if (type != 4) return 0;
  const char *object = sd_bus_message_get_path(message);
  if (!object) return failed(manager, EPROTO);
#ifdef NP_RETAINED_V2_B1A
  if(manager->actor_observer_armed) {
    const char *unit=NULL,*object_path=NULL,*outcome=NULL;uint32_t id=0;
    enum np_actor_observer_note note=NP_ACTOR_UNIT_NEW;bool actor=false;
    if(sd_bus_message_is_signal(message,MANAGER_INTERFACE,"UnitNew")>0){
      if(sd_bus_message_has_signature(message,"so")<=0 || sd_bus_message_read(message,"so",&unit,&object_path)<=0)return failed(manager,EPROTO);
    }else if(sd_bus_message_is_signal(message,MANAGER_INTERFACE,"JobNew")>0){
      note=NP_ACTOR_JOB_NEW;
      if(sd_bus_message_has_signature(message,"uos")<=0 || sd_bus_message_read(message,"uos",&id,&object_path,&unit)<=0)return failed(manager,EPROTO);
    }else if(sd_bus_message_is_signal(message,MANAGER_INTERFACE,"JobRemoved")>0){
      note=NP_ACTOR_JOB_REMOVED;
      if(sd_bus_message_has_signature(message,"uoss")<=0 || sd_bus_message_read(message,"uoss",&id,&object_path,&unit,&outcome)<=0)return failed(manager,EPROTO);
    }
    if(unit){
      /* Once armed, slice/target/foreign notifications are all unexpected.
       * No cursor rewind, broad allowlist or accepted-event counter reset. */
      if(strcmp(object,MANAGER_PATH) || np_actor_observer_note(&manager->actor_debt,note,unit,object_path,id,outcome))return failed(manager,ESTALE);
      actor=true;
    }else if(sd_bus_message_is_signal(message,"org.freedesktop.DBus.Properties","PropertiesChanged")>0){
      if(np_actor_notification_decode(message,&manager->actor_debt))return failed(manager,ESTALE);
      actor=true;
    }
    if(actor){if(manager->actor_events==NP_ACTOR_MESSAGES)return failed(manager,ENOBUFS);manager->actor_events++;return 0;}
    return failed(manager,ESTALE);
  }
#endif
  if (sd_bus_message_is_signal(message, "org.freedesktop.DBus.Properties", "PropertiesChanged") > 0) {
    if ((strcmp(object, manager->slice_path) && strcmp(object, manager->target_path)) || sd_bus_message_has_signature(message, "sa{sv}as") <= 0) return failed(manager, EPROTO);
    return 0;
  }
  if (strcmp(object, MANAGER_PATH)) return failed(manager, EPROTO);
  if (sd_bus_message_is_signal(message, MANAGER_INTERFACE, "JobRemoved") > 0) {
    if (manager->job_count == manager->capacity || sd_bus_message_has_signature(message, "uoss") <= 0) return failed(manager, ENOBUFS);
    struct retained_job *row = &manager->jobs[manager->job_count]; const char *job, *unit, *outcome;
    if (sd_bus_message_read(message, "uoss", &row->id, &job, &unit, &outcome) <= 0 || (strcmp(unit, manager->slice) && strcmp(unit, manager->target)) || copy(row->path, sizeof row->path, job) || copy(row->unit, sizeof row->unit, unit) || copy(row->outcome, sizeof row->outcome, outcome)) return failed(manager, EPROTO);
    row->event = manager->observation.events; row->original = sd_bus_message_ref(message); manager->job_count++;
    if (correlate(manager, NP_SLICE_START) || correlate(manager, NP_TARGET_START)) return -1;
  } else if (sd_bus_message_is_signal(message, MANAGER_INTERFACE, "Reloading") > 0) {
    int active;
    if (manager->observation.requests[NP_RELOAD].state == NP_REQUEST_UNSENT || sd_bus_message_has_signature(message, "b") <= 0 || sd_bus_message_read(message, "b", &active) <= 0) return failed(manager, EPROTO);
    if (active) { if (manager->observation.reload_started || manager->observation.reload_finished) return failed(manager, EPROTO); manager->observation.reload_started = true; manager->reload_events[0] = sd_bus_message_ref(message); }
    else { if (!manager->observation.reload_started || manager->observation.reload_finished) return failed(manager, EPROTO); manager->observation.reload_finished = true; manager->reload_events[1] = sd_bus_message_ref(message); }
  } else if (sd_bus_message_is_signal(message, MANAGER_INTERFACE, "UnitNew") > 0 || sd_bus_message_is_signal(message, MANAGER_INTERFACE, "UnitRemoved") > 0 || sd_bus_message_is_signal(message, MANAGER_INTERFACE, "JobNew") > 0) {
    const char *unit, *unused; uint32_t id;
    if (sd_bus_message_is_signal(message, MANAGER_INTERFACE, "JobNew") > 0) { if (sd_bus_message_read(message, "uos", &id, &unused, &unit) <= 0) return failed(manager, EPROTO); }
    else if (sd_bus_message_read(message, "so", &unit, &unused) <= 0) return failed(manager, EPROTO);
    if (strcmp(unit, manager->slice) && strcmp(unit, manager->target)) return failed(manager, EPROTO);
    if (sd_bus_message_is_signal(message, MANAGER_INTERFACE, "UnitRemoved") > 0) return failed(manager, ESTALE);
  } else return failed(manager, EPROTO);
  return 0;
}
static int strings(sd_bus_message *reply, const char *expected) {
  if (sd_bus_message_enter_container(reply, 'a', "s") <= 0) return -1;
  const char *actual; int count = 0, result;
  while ((result = sd_bus_message_read(reply, "s", &actual)) > 0) { if (!expected || count++ || strcmp(actual, expected)) return -1; }
  if (result < 0 || (expected && count != 1)) return -1;
  return sd_bus_message_exit_container(reply) < 0 ? -1 : 0;
}
static int fragment_path(struct np_stock_manager *manager, const char *observed) {
  if (!manager->fragment || np_fragment_verify_v1(manager->fragment)) return -1;
  char actual[4096] = ""; size_t used = 0;
  const struct np_directory *directory = manager->fragment->final;
  for (size_t i = 1; i < directory->count; i++) {
    int n = snprintf(actual + used, sizeof actual - used, "/%s", directory->names[i]);
    if (n <= 0 || (size_t)n >= sizeof actual - used) return -1;
    used += (size_t)n;
  }
  int n = snprintf(actual + used, sizeof actual - used, "/%s", manager->fragment->final_name);
  return n > 0 && (size_t)n < sizeof actual - used && !strcmp(actual, observed) ? 0 : -1;
}
static int cpu_facts(struct np_stock_manager *manager, sd_bus_message *reply) {
#ifndef NP_RETAINED_V2_A1
  (void)manager;
#endif
#ifdef NP_RETAINED_V2_A1
  bool group_seen = false;
#endif
  bool seen = false;
  if (sd_bus_message_has_signature(reply, "a{sv}") <= 0 || sd_bus_message_enter_container(reply, 'a', "{sv}") <= 0) return -1;
  int entry;
  while ((entry = sd_bus_message_enter_container(reply, 'e', "sv")) > 0) {
    const char *key;
    if (sd_bus_message_read(reply, "s", &key) <= 0) return -1;
    if (!strcmp(key, "CPUWeight")) {
      uint64_t weight;
      if (seen || sd_bus_message_enter_container(reply, 'v', "t") <= 0 || sd_bus_message_read(reply, "t", &weight) <= 0 || weight != 100 || sd_bus_message_exit_container(reply) < 0) return -1;
      seen = true;
#ifdef NP_RETAINED_V2_A1
    } else if (!strcmp(key, "ControlGroup")) {
      const char *group;
      char expected[512];
      int n = snprintf(expected, sizeof expected, "/subscription.slice/subscription-runtime.slice/subscription-runtime-hosted.slice/%s", manager->slice);
      if (group_seen || n <= 0 || (size_t)n >= sizeof expected || sd_bus_message_enter_container(reply, 'v', "s") <= 0 || sd_bus_message_read(reply, "s", &group) <= 0 || strcmp(group, expected) || sd_bus_message_exit_container(reply) < 0) return -1;
      group_seen = true;
#endif
    } else if (sd_bus_message_skip(reply, "v") <= 0) return -1;
    if (sd_bus_message_exit_container(reply) < 0) return -1;
  }
  return seen
#ifdef NP_RETAINED_V2_A1
    && group_seen
#endif
    && entry == 0 && sd_bus_message_exit_container(reply) >= 0 ? 0 : -1;
}
static int facts(struct np_stock_manager *manager, enum np_manager_step step, sd_bus_message *reply) {
  if (slice_property_step(step)) return cpu_facts(manager, reply);
  bool target = step == NP_TARGET_PRESTART_FACTS || step == NP_TARGET_FACTS;
  bool active = step != NP_TARGET_PRESTART_FACTS;
  const char *unit = target ? manager->target : manager->slice;
  unsigned seen = 0;
  if (sd_bus_message_has_signature(reply, "a{sv}") <= 0 || sd_bus_message_enter_container(reply, 'a', "{sv}") <= 0) return -1;
  int entry;
  while ((entry = sd_bus_message_enter_container(reply, 'e', "sv")) > 0) {
    const char *key;
    if (sd_bus_message_read(reply, "s", &key) <= 0) return -1;
    const char *type = NULL; unsigned bit = 0;
    if (!strcmp(key, "Id")) { type = "s"; bit = 1; }
    else if (!strcmp(key, "Names")) { type = "as"; bit = 2; }
    else if (!strcmp(key, "LoadState")) { type = "s"; bit = 4; }
    else if (!strcmp(key, "ActiveState")) { type = "s"; bit = 8; }
    else if (!strcmp(key, "InvocationID")) { type = "ay"; bit = 16; }
    else if (target && !strcmp(key, "Requires")) { type = "as"; bit = 32; }
    else if (target && !strcmp(key, "After")) { type = "as"; bit = 64; }
    else if (target && !strcmp(key, "FragmentPath")) { type = "s"; bit = 128; }
    else if (target && !strcmp(key, "SourcePath")) { type = "s"; bit = 256; }
    else if (target && !strcmp(key, "DropInPaths")) { type = "as"; bit = 512; }
    else if (target && !strcmp(key, "Transient")) { type = "b"; bit = 1024; }
    else if (target && !strcmp(key, "NeedDaemonReload")) { type = "b"; bit = 2048; }
    if (!type) { if (sd_bus_message_skip(reply, "v") <= 0) return -1; }
    else {
      if ((seen & bit) || sd_bus_message_enter_container(reply, 'v', type) <= 0) return -1;
      seen |= bit;
      if (!strcmp(type, "s")) {
        const char *text; if (sd_bus_message_read(reply, "s", &text) <= 0) return -1;
        if ((bit == 1 && strcmp(text, unit)) || (bit == 4 && strcmp(text, "loaded")) || (bit == 8 && strcmp(text, active ? "active" : "inactive")) || (bit == 128 && fragment_path(manager, text)) || (bit == 256 && *text)) return -1;
      } else if (!strcmp(type, "as")) { if (strings(reply, bit == 2 ? unit : bit == 512 ? NULL : manager->slice)) return -1; }
      else if (!strcmp(type, "b")) { int flag; if (sd_bus_message_read(reply, "b", &flag) <= 0 || flag) return -1; }
      else {
        const void *bytes; size_t length;
        if (sd_bus_message_read_array(reply, 'y', &bytes, &length) <= 0) return -1;
        uint8_t zero[16] = {0}, *retained = target ? manager->observation.target_invocation : manager->observation.slice_invocation;
        if (length != 16 || (active ? !memcmp(bytes, zero, 16) : memcmp(bytes, zero, 16))) return -1;
        if (active && memcmp(retained, zero, 16) && memcmp(retained, bytes, 16)) return -1;
        if (active) memcpy(retained, bytes, 16);
      }
      if (sd_bus_message_exit_container(reply) < 0) return -1;
    }
    if (sd_bus_message_exit_container(reply) < 0) return -1;
  }
  return entry == 0 && seen == (target ? 4095U : 31U) && sd_bus_message_exit_container(reply) >= 0 ? 0 : -1;
}
static int reply(sd_bus_message *message, void *data, sd_bus_error *error) {
  (void)error; struct retained_call *call = data; struct np_stock_manager *manager = call->owner;
  struct np_request_observation *row = &manager->observation.requests[call->step];
  call->reply = sd_bus_message_ref(message); uint64_t cookie;
  if (row->state != NP_REQUEST_DISPATCHED || sd_bus_message_get_reply_cookie(message, &cookie) < 0 || cookie != row->serial || association(manager)) { row->state = NP_REQUEST_UNCERTAIN; return failed(manager, EPROTO); }
  if (sd_bus_message_get_cookie(message, &row->reply_serial) < 0 || !row->reply_serial) { row->state = NP_REQUEST_UNCERTAIN; return failed(manager, EPROTO); }
  if (np_clock_sample_v1(manager->gate->clock, &row->observed_ns)) { row->state = NP_REQUEST_UNCERTAIN; return failed(manager, ESTALE); }
  row->late = row->observed_ns >= manager->gate->cutoff;
  if (call->step == NP_TARGET_ABSENT) {
    if (sd_bus_message_is_method_error(message, "org.freedesktop.systemd1.NoSuchUnit") <= 0) { row->state = NP_REQUEST_FAILED; return failed(manager, EEXIST); }
  } else if (sd_bus_message_is_method_error(message, NULL) > 0) { row->state = NP_REQUEST_FAILED; return failed(manager, EIO); }
  else if (call->step == NP_SLICE_START || call->step == NP_TARGET_START || call->step == NP_TARGET_LOAD) {
    const char *object;
    if (sd_bus_message_has_signature(message, "o") <= 0 || sd_bus_message_read(message, "o", &object) <= 0) return failed(manager, EPROTO);
    if (call->step == NP_TARGET_LOAD) { if (strcmp(object, manager->target_path)) return failed(manager, EPROTO); }
    else {
      unsigned id; int end = 0;
      if (copy(row->job, sizeof row->job, object) || sscanf(object, MANAGER_PATH "/job/%u%n", &id, &end) != 1 || object[end] || !id) return failed(manager, EPROTO);
      char canonical[128]; int n = snprintf(canonical, sizeof canonical, MANAGER_PATH "/job/%u", id);
      if (n <= 0 || (size_t)n >= sizeof canonical || strcmp(canonical, object)) return failed(manager, EPROTO);
      row->job_id = id; row->job_reply = true;
      if (correlate(manager, call->step)) return -1;
    }
  } else if (property_step(call->step)) { if (facts(manager, call->step, message)) return failed(manager, EPROTO); }
  else if (sd_bus_message_has_signature(message, "") <= 0) return failed(manager, EPROTO);
  row->state = NP_REQUEST_REPLIED;
  if (row->late) { manager->observation.closed = true; manager->gate->closed = true; }
  return 0;
}
static int retained_birth(struct np_birth *to, const struct np_birth *from) {
  *to = *from; to->pidfd = to->time = to->children = -1;
  to->pidfd = fcntl(from->pidfd, F_DUPFD_CLOEXEC, 4); to->time = fcntl(from->time, F_DUPFD_CLOEXEC, 4); to->children = fcntl(from->children, F_DUPFD_CLOEXEC, 4);
  return to->pidfd < 0 || to->time < 0 || to->children < 0 ? -1 : 0;
}
int np_manager_connect_v1(struct np_stock_manager **out, int socket, const struct np_birth *birth, struct np_gate *gate, const char locator[65], uint64_t generation, size_t capacity) {
  *out = NULL;
  if (!birth || !gate || !generation || !capacity || capacity > 4096 || !locator || strlen(locator) != 64 || strspn(locator, "0123456789abcdef") != 64) { errno = EINVAL; return -1; }
  struct ucred peer; socklen_t size = sizeof peer; int type; socklen_t length = sizeof type; struct sockaddr_storage address; socklen_t address_size = sizeof address;
  if (birth->uid != 0 || birth->gid != 0 || np_birth_associate_v1(gate->clock, birth) || getsockopt(socket, SOL_SOCKET, SO_TYPE, &type, &length) || type != SOCK_STREAM || getsockname(socket, (struct sockaddr *)&address, &address_size) || address.ss_family != AF_UNIX || getsockopt(socket, SOL_SOCKET, SO_PEERCRED, &peer, &size) || size != sizeof peer || peer.pid != birth->pid || peer.uid != 0 || peer.gid != 0) { errno = EPERM; return -1; }
  struct np_stock_manager *manager = calloc(1, sizeof *manager);
  if (!manager) return -1;
  *out = manager; manager->birth.pidfd = manager->birth.time = manager->birth.children = -1;
  manager->gate = gate; manager->capacity = capacity; manager->observation.generation = generation;
  manager->jobs = calloc(capacity, sizeof *manager->jobs);
  manager->incoming = calloc(capacity, sizeof *manager->incoming);
  if (!manager->incoming || !manager->jobs || retained_birth(&manager->birth, birth)) return failed(manager, ENOMEM);
  int a = snprintf(manager->slice, sizeof manager->slice, "subscription-runtime-hosted-%s.slice", locator);
  int b = snprintf(manager->target, sizeof manager->target, "subscription-runtime-retain-%s.target", locator);
  if (a <= 0 || (size_t)a >= sizeof manager->slice || b <= 0 || (size_t)b >= sizeof manager->target || path(manager->slice_path, sizeof manager->slice_path, manager->slice) || path(manager->target_path, sizeof manager->target_path, manager->target)) return failed(manager, EINVAL);
  for (int i = 0; i < NP_MANAGER_STEPS; i++) { manager->calls[i].owner = manager; manager->calls[i].step = (enum np_manager_step)i; }
  if (sd_bus_new(&manager->bus) < 0 || sd_bus_set_bus_client(manager->bus, 0) < 0 || sd_bus_set_allow_interactive_authorization(manager->bus, 0) < 0) return failed(manager, EIO);
  int duplicate = fcntl(socket, F_DUPFD_CLOEXEC, 4);
  if (duplicate < 0) return failed(manager, errno);
  if (sd_bus_set_fd(manager->bus, duplicate, duplicate) < 0) { close(duplicate); return failed(manager, EIO); }
  if (sd_bus_add_filter(manager->bus, &manager->filter, events, manager) < 0 || boundary(manager) || sd_bus_start(manager->bus) < 0 || boundary(manager)) return failed(manager, EIO);
  uint64_t end = gate->clock->high_water + UINT64_C(2000000000);
  if (end > gate->cutoff) end = gate->cutoff;
  while (sd_bus_is_ready(manager->bus) <= 0) {
    uint64_t now;
    if (boundary(manager) || np_clock_sample_v1(gate->clock, &now) || now >= end) return failed(manager, ETIMEDOUT);
    int progress = sd_bus_process(manager->bus, NULL);
    if (progress < 0 || boundary(manager)) return failed(manager, EIO);
    if (!progress && sd_bus_wait(manager->bus, (end - now) / 1000) < 0) return failed(manager, EIO);
  }
  return 0;
}
static int arguments(struct np_stock_manager *manager, enum np_manager_step step, sd_bus_message *message) {
  if (step == NP_SLICE_START) {
    if (sd_bus_message_append(message, "ss", manager->slice, "fail") < 0 || sd_bus_message_open_container(message, 'a', "(sv)") < 0 || sd_bus_message_open_container(message, 'r', "sv") < 0 || sd_bus_message_append(message, "s", "CPUWeight") < 0 || sd_bus_message_open_container(message, 'v', "t") < 0 || sd_bus_message_append(message, "t", UINT64_C(100)) < 0 || sd_bus_message_close_container(message) < 0 || sd_bus_message_close_container(message) < 0 || sd_bus_message_close_container(message) < 0 || sd_bus_message_open_container(message, 'a', "(sa(sv))") < 0 || sd_bus_message_close_container(message) < 0) return -1;
  } else if (step == NP_TARGET_START) { if (sd_bus_message_append(message, "ss", manager->target, "fail") < 0) return -1; }
  else if (property_step(step)) { if (sd_bus_message_append(message, "s", slice_property_step(step) ? "org.freedesktop.systemd1.Slice" : UNIT_INTERFACE) < 0) return -1; }
  else if (step != NP_SUBSCRIBE && step != NP_RELOAD) { if (sd_bus_message_append(message, "s", step == NP_SLICE_REF ? manager->slice : manager->target) < 0) return -1; }
  return 0;
}
int np_manager_dispatch_v1(struct np_stock_manager *manager, enum np_manager_step step, struct np_publication *fragment, struct np_resource_pair *pair) {
#ifdef NP_RETAINED_V2_B1A
  if(step==NP_SLICE_REF || step==NP_TARGET_REF){errno=ENOTSUP;return -1;}
#endif
  if (step < 0 || step >= NP_MANAGER_STEPS) { errno = EINVAL; return -1; }
  struct np_request_observation *row = &manager->observation.requests[step];
  if (row->state != NP_REQUEST_UNSENT || boundary(manager)) { errno = EALREADY; return -1; }
  if (step && !replied(manager, (enum np_manager_step)(step - 1))) { errno = EAGAIN; return -1; }
  if ((step == NP_SLICE_REF || step >= NP_RELOAD) && !successful_job(manager, NP_SLICE_START)) { errno = EAGAIN; return -1; }
  if (step >= NP_RELOAD) {
    if (!fragment || !pair || fragment->stage != NP_FILE_VERIFIED || fragment->uncertain || pair->uncertain || np_fragment_verify_v1(fragment) || np_resource_pair_check_v1(pair) || strcmp(pair->slice, manager->slice)) return failed(manager, ESTALE);
    if (manager->fragment && (manager->fragment != fragment || manager->pair != pair)) return failed(manager, ESTALE);
    manager->fragment = fragment; manager->pair = pair;
  }
  if (step > NP_RELOAD && (!manager->observation.reload_started || !manager->observation.reload_finished)) { errno = EAGAIN; return -1; }
  if (step >= NP_TARGET_FACTS && !successful_job(manager, NP_TARGET_START)) { errno = EAGAIN; return -1; }
  struct retained_call *call = &manager->calls[step];
  bool properties = property_step(step), target = step == NP_TARGET_PRESTART_FACTS || step == NP_TARGET_FACTS;
  if (sd_bus_message_new_method_call(manager->bus, &call->request, "org.freedesktop.systemd1", properties ? target ? manager->target_path : manager->slice_path : MANAGER_PATH, properties ? "org.freedesktop.DBus.Properties" : MANAGER_INTERFACE, methods[step]) < 0 || sd_bus_message_set_auto_start(call->request, 0) < 0 || sd_bus_message_set_allow_interactive_authorization(call->request, 0) < 0 || arguments(manager, step, call->request)) return failed(manager, EIO);
  if (boundary(manager)) return -1;
  row->sent_ns = manager->gate->clock->high_water; row->state = NP_REQUEST_DISPATCHED;
  if (sd_bus_call_async(manager->bus, &call->slot, call->request, reply, call, UINT64_C(2000000)) < 0 || sd_bus_message_get_cookie(call->request, &row->serial) < 0 || !row->serial) { row->state = NP_REQUEST_UNCERTAIN; return failed(manager, EIO); }
  /* call_async may queue output. Drain this one admitted original request in
   * the dispatch lane, bracketed by the retained cutoff. JOIN never flushes. */
  if (boundary(manager) || sd_bus_flush(manager->bus) < 0) { row->state = NP_REQUEST_UNCERTAIN; row->late = true; manager->observation.closed = true; manager->gate->closed = true; return -1; }
  row->dispatched_after_ns = manager->gate->clock->high_water;
  if (boundary(manager)) { row->late = true; return -1; }
  row->dispatched_after_ns = manager->gate->clock->high_water;
  uint64_t queued;
  if (sd_bus_get_n_queued_write(manager->bus, &queued) < 0 || queued) { row->state = NP_REQUEST_UNCERTAIN; return failed(manager, EIO); }
  return 0;
}
int np_manager_join_v1(struct np_stock_manager *manager, uint64_t end) {
  uint64_t now;
  if (association(manager) || np_clock_sample_v1(manager->gate->clock, &now) || end > manager->gate->clock->cleanup_end || end <= now || end - now > UINT64_C(2000000000)) { errno = ETIMEDOUT; return -1; }
  uint64_t queued;
  if (sd_bus_get_n_queued_write(manager->bus, &queued) < 0 || queued) { manager->observation.closed = true; manager->gate->closed = true; errno = EBUSY; return -1; }
  /* Original connection only. No request construction/dispatch, reference,
   * namespace adoption, descriptor acquisition or publication in this lane. */
  for (;;) {
    int progress = sd_bus_process(manager->bus, NULL);
    if (progress < 0 || manager->observation.lost || sd_bus_get_n_queued_write(manager->bus, &queued) < 0 || queued) return failed(manager, EIO);
    if (np_clock_sample_v1(manager->gate->clock, &now) || now >= end || association(manager)) return 0;
    if (!progress) return 0;
  }
}
void np_manager_close_v1(struct np_stock_manager *manager) { manager->observation.closed = true; manager->gate->closed = true; }
void np_manager_snapshot_v1(const struct np_stock_manager *manager, struct np_manager_observation *out) { *out = manager->observation; }
void np_manager_release_v1(struct np_stock_manager *manager) {
  if (!manager) return;
  /* Explicit native parent disposal only, never helper/NAPI cleanup. */
  for (int i = 0; i < NP_MANAGER_STEPS; i++) { sd_bus_slot_unref(manager->calls[i].slot); sd_bus_message_unref(manager->calls[i].request); sd_bus_message_unref(manager->calls[i].reply); }
  for (size_t i = 0; i < manager->job_count; i++) sd_bus_message_unref(manager->jobs[i].original);
  for (uint64_t i = 0; i < manager->observation.events; i++) sd_bus_message_unref(manager->incoming[i]);
  sd_bus_message_unref(manager->reload_events[0]); sd_bus_message_unref(manager->reload_events[1]);
  sd_bus_slot_unref(manager->filter); sd_bus_close_unref(manager->bus); np_birth_release_v1(&manager->birth); free(manager->jobs); free(manager->incoming); free(manager);
}

#ifdef NP_RETAINED_V2_A1
int np_manager_current_v2(struct np_stock_manager *manager) {
  uint64_t now;
  if (!manager || boundary(manager) || np_clock_sample_v1(manager->gate->clock, &now)) return -1;
  uint64_t observed_events = manager->observation.events;
#ifdef NP_RETAINED_V2_B1A
  uint64_t observed_actor_events=manager->actor_events;
#endif
  uint64_t end = now + UINT64_C(1000000);
  if (end > manager->gate->cutoff) end = manager->gate->cutoff;
#ifdef NP_RETAINED_V2_B1A
  if (end <= now || np_manager_join_v1(manager, end) || boundary(manager) || !manager->references || np_managed_retained_current_v2(manager->reference_origin,manager->references)) return failed(manager, ESTALE);
  if(manager->actor_observer_armed){
    if(manager->observation.events-observed_events!=manager->actor_events-observed_actor_events || !manager->actor_connection || np_actor_manager_observer_check(manager->actor_connection,&manager->actor_debt))return failed(manager,ESTALE);
  }else
  if(manager->observation.events!=observed_events)return failed(manager,ESTALE);
#else
  if (end <= now || np_manager_join_v1(manager, end) || manager->observation.events != observed_events || boundary(manager)) return failed(manager, ESTALE);
#endif
  return 0;
}
#ifdef NP_RETAINED_V2_B1A
int np_manager_reference_v2(struct np_stock_manager *m,enum np_manager_step step,struct np_root_origin *origin,struct np_managed_original *references,const char digest[65]){
  if(!m || (step!=NP_SLICE_REF && step!=NP_TARGET_REF) || !origin || !references || !digest || boundary(m))return -1;
  char expected[128];int n=snprintf(expected,sizeof expected,step==NP_SLICE_REF?"subscription-runtime-hosted-%s.slice":"subscription-runtime-retain-%s.target",digest);
  if(n<=0 || (size_t)n>=sizeof expected || strcmp(expected,step==NP_SLICE_REF?m->slice:m->target))return failed(m,ESTALE);
  struct np_request_observation *r=&m->observation.requests[step];
  if(r->state!=NP_REQUEST_UNSENT || !replied(m,(enum np_manager_step)(step-1)) || !successful_job(m,NP_SLICE_START) || (m->references && (m->references!=references || m->reference_origin!=origin)))return failed(m,ESTALE);
  m->references=references;m->reference_origin=origin;
  r->state=NP_REQUEST_DISPATCHED;r->sent_ns=m->gate->clock->high_water;
  uint64_t cookies[2];
  if(np_managed_retained_ref_v2(origin,references,step==NP_SLICE_REF?0:1,digest,cookies) || boundary(m)){r->state=NP_REQUEST_UNCERTAIN;return failed(m,ESTALE);}
  r->serial=cookies[0];r->reply_serial=cookies[1];r->observed_ns=r->dispatched_after_ns=m->gate->clock->high_water;r->state=NP_REQUEST_REPLIED;return 0;
}
int np_manager_actor_observer_v2(struct np_stock_manager *manager,const char reservation[65]) {
  if(!manager || !reservation || manager->actor_observer_armed || strnlen(reservation,65)!=64 || strspn(reservation,"0123456789abcdef")!=64 || boundary(manager))return -1;
  for(unsigned i=0;i<NP_MANAGER_STEPS;i++)if(!replied(manager,(enum np_manager_step)i))return failed(manager,ESTALE);
  int n=snprintf(manager->actor_debt.unit,sizeof manager->actor_debt.unit,"subscription-runtime-actors-%s.scope",reservation);
  if(n<=0 || (size_t)n>=sizeof manager->actor_debt.unit || path(manager->actor_debt.path,sizeof manager->actor_debt.path,manager->actor_debt.unit))return failed(manager,EPROTO);
  manager->actor_observer_armed=true;return 0;
}
int np_manager_actor_observer_bind_v2(struct np_stock_manager *manager,const struct np_actor_manager *actor) {
  if(!manager || !actor || !manager->actor_observer_armed || manager->actor_connection || boundary(manager) || np_actor_manager_observer_check(actor,&manager->actor_debt))return -1;
  manager->actor_connection=actor;return 0;
}
#endif
#endif
