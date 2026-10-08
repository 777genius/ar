#define _GNU_SOURCE
#include "original-owner.h"
#include <pthread.h>
#include <sys/syscall.h>
#include <unistd.h>
/* Stable opaque Node-API declarations, matching the existing v1 addon seam.
 * This is a fixed protected startup module, not a constructor/FD importer. */
typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef struct napi_ref__ *napi_ref;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
extern int napi_create_function(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
extern int napi_set_named_property(napi_env, napi_value, const char *, napi_value);
extern int napi_get_boolean(napi_env, bool, napi_value *);
extern int napi_throw_error(napi_env, const char *, const char *);
extern int napi_get_cb_info(napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **);
extern int napi_create_reference(napi_env, napi_value, uint32_t, napi_ref *);
extern int napi_get_reference_value(napi_env, napi_ref, napi_value *);
extern int napi_delete_reference(napi_env, napi_ref);
extern int napi_strict_equals(napi_env, napi_value, napi_value, bool *);
extern int napi_add_env_cleanup_hook(napi_env, void (*)(void *), void *);
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static struct {
  napi_env env;
  napi_ref wrapper;
  uint64_t generation;
  pid_t pid;
  bool issued, disposed;
} binding;
static void loss(void *opaque) {
  (void)pthread_mutex_lock(&lock);
  if (opaque == &binding && !binding.disposed) {
    binding.disposed = true; np_original_helper_loss_v1();
    if (binding.wrapper) (void)napi_delete_reference(binding.env, binding.wrapper);
    binding.wrapper = NULL; binding.env = NULL;
  }
  (void)pthread_mutex_unlock(&lock);
}
static bool exact(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value arg, self, original; void *data = NULL; bool same = false;
  return !binding.disposed && env == binding.env && binding.pid == getpid() && binding.generation && binding.wrapper &&
    napi_get_cb_info(env, info, &count, &arg, &self, &data) == 0 && count == 0 && data == &binding &&
    napi_get_reference_value(env, binding.wrapper, &original) == 0 && napi_strict_equals(env, self, original, &same) == 0 && same;
}
static napi_value message(napi_env env, napi_callback_info info, uint16_t kind) {
  (void)pthread_mutex_lock(&lock);
  bool accepted = exact(env, info) && np_original_helper_message_v1(kind) == 0;
  if (!accepted) { binding.disposed = true; np_original_helper_loss_v1(); }
  napi_value result = NULL;
  if (napi_get_boolean(env, accepted, &result) != 0) { binding.disposed = true; np_original_helper_loss_v1(); result = NULL; }
  (void)pthread_mutex_unlock(&lock); return result;
}
static napi_value observe(napi_env env, napi_callback_info info) { return message(env, info, NP_JOIN); }
static napi_value close_admission(napi_env env, napi_callback_info info) { return message(env, info, NP_CLOSE); }
napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  (void)pthread_mutex_lock(&lock);
  /* Only the original main-thread environment can run protected startup.
   * Loading a copied export or another environment irreversibly loses binding. */
  if (binding.issued || syscall(SYS_gettid) != getpid()) {
    binding.disposed = true; np_original_helper_loss_v1();
    (void)pthread_mutex_unlock(&lock);
    (void)napi_throw_error(env, NULL, "original native environment refused"); return NULL;
  }
  binding.issued = true; binding.env = env; binding.pid = getpid();
  if (napi_create_reference(env, exports, 1, &binding.wrapper) != 0 || napi_add_env_cleanup_hook(env, loss, &binding) != 0 ||
#ifdef NP_ASSOCIATED_ORIGIN_V2
      np_original_helper_start_associated_v2(&binding.generation)
#else
      np_original_helper_start_v1(&binding.generation)
#endif
      ) {
    binding.disposed = true; np_original_helper_loss_v1();
    (void)pthread_mutex_unlock(&lock);
    (void)napi_throw_error(env, NULL, "original native startup refused"); return NULL;
  }
  napi_value callable;
  if (napi_create_function(env, "observe", 7, observe, &binding, &callable) != 0 || napi_set_named_property(env, exports, "observe", callable) != 0 ||
      napi_create_function(env, "close", 5, close_admission, &binding, &callable) != 0 || napi_set_named_property(env, exports, "close", callable) != 0) {
    binding.disposed = true; np_original_helper_loss_v1();
    (void)pthread_mutex_unlock(&lock); return NULL;
  }
  (void)pthread_mutex_unlock(&lock); return exports;
}
