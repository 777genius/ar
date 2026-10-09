#define _GNU_SOURCE
#include "mechanisms.h"
#include <errno.h>
#include <fcntl.h>
#include <stdatomic.h>
#include <sys/syscall.h>
#include <unistd.h>
/* Test consumer of the existing native filter, never a production registrar.
 * Minimal stable Node-API v1 declarations (opaque types, no struct layouts):
 * https://github.com/nodejs/node/blob/v24.8.0/src/js_native_api.h
 * No Node development headers or dependency download is required. */
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
extern int napi_create_function(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
extern int napi_set_named_property(napi_env, napi_value, const char *, napi_value);
extern int napi_get_boolean(napi_env, bool, napi_value *);
extern int napi_throw_error(napi_env, const char *, const char *);
static atomic_bool sealed;
static napi_value probe(napi_env env, napi_callback_info info) {
  (void)info;
  // Exercise every ring syscall independently on main/existing/fresh Node
  // threads. Invalid inputs cannot create a resource if a denial regresses.
  errno = 0; bool setup_refused = syscall(SYS_io_uring_setup, 0U, NULL) < 0 && errno == EPERM;
  errno = 0; bool enter_refused = syscall(SYS_io_uring_enter, -1, 0U, 0U, 0U, NULL, 0U) < 0 && errno == EPERM;
  errno = 0; bool register_refused = syscall(SYS_io_uring_register, -1, 0U, NULL, 0U) < 0 && errno == EPERM;
  bool refused = syscall(SYS_fork) < 0 && errno == EPERM;
  refused = refused && syscall(SYS_clone3, NULL, 0) < 0 && errno == ENOSYS;
  refused = refused && syscall(SYS_dup, NP_ENDPOINT) < 0 && errno == EPERM;
  refused = refused && fcntl(NP_ENDPOINT, F_DUPFD_CLOEXEC, 32) < 0 && errno == EPERM;
  refused = refused && fcntl(NP_ENDPOINT, F_SETFD, 0) < 0 && errno == EPERM;
  refused = refused && syscall(SYS_sendmsg, NP_ENDPOINT, NULL, 0) < 0 && errno == EPERM;
  refused = refused && setup_refused && enter_refused && register_refused;
  napi_value result = NULL;
  if (napi_get_boolean(env, refused, &result) != 0) return NULL;
  return result;
}
/* All thread environments share the process's one original TSYNC operation.
 * Subsequent environments only exercise refusal. This grants no Source API. */
napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  if (!atomic_load_explicit(&sealed, memory_order_acquire)) {
    if (fcntl(NP_ENDPOINT, F_SETFD, FD_CLOEXEC) || np_helper_filter_v1()) {
      (void)napi_throw_error(env, NULL, "native contract filter refused"); return NULL;
    }
    atomic_store_explicit(&sealed, true, memory_order_release);
  }
  napi_value callable;
  if (napi_create_function(env, "probe", 5, probe, NULL, &callable) != 0 || napi_set_named_property(env, exports, "probe", callable) != 0) return NULL;
  return exports;
}
