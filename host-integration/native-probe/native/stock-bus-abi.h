#ifndef SR_NATIVE_PROBE_STOCK_BUS_ABI_H
#define SR_NATIVE_PROBE_STOCK_BUS_ABI_H
#include <stddef.h>
#include <stdint.h>
/* Narrow stable stock libsystemd ABI, not an implementation or patched manager.
 * https://github.com/systemd/systemd/blob/v257/src/systemd/sd-bus.h
 * This build environment lacks development headers; only these opaque handles
 * and public function signatures are used. Actual installed library/build and
 * private manager provenance remain protected image-admission requirements. */
typedef struct sd_bus sd_bus;
typedef struct sd_bus_message sd_bus_message;
typedef struct sd_bus_slot sd_bus_slot;
typedef struct { const char *name, *message; int _need_free; } sd_bus_error;
typedef int (*sd_bus_message_handler_t)(sd_bus_message *, void *, sd_bus_error *);
int sd_bus_new(sd_bus **);
int sd_bus_set_fd(sd_bus *, int, int);
int sd_bus_set_bus_client(sd_bus *, int);
int sd_bus_set_allow_interactive_authorization(sd_bus *, int);
int sd_bus_start(sd_bus *);
int sd_bus_is_ready(sd_bus *);
int sd_bus_get_fd(sd_bus *);
int sd_bus_get_unique_name(sd_bus *, const char **);
sd_bus *sd_bus_message_get_bus(sd_bus_message *);
const char *sd_bus_message_get_sender(sd_bus_message *);
int sd_bus_process(sd_bus *, sd_bus_message **);
int sd_bus_wait(sd_bus *, uint64_t);
int sd_bus_flush(sd_bus *);
int sd_bus_get_n_queued_write(sd_bus *, uint64_t *);
sd_bus *sd_bus_close_unref(sd_bus *);
int sd_bus_add_filter(sd_bus *, sd_bus_slot **, sd_bus_message_handler_t, void *);
int sd_bus_call_async(sd_bus *, sd_bus_slot **, sd_bus_message *, sd_bus_message_handler_t, void *, uint64_t);
sd_bus_slot *sd_bus_slot_unref(sd_bus_slot *);
int sd_bus_message_new_method_call(sd_bus *, sd_bus_message **, const char *, const char *, const char *, const char *);
sd_bus_message *sd_bus_message_ref(sd_bus_message *);
sd_bus_message *sd_bus_message_unref(sd_bus_message *);
int sd_bus_message_get_cookie(sd_bus_message *, uint64_t *);
int sd_bus_message_get_reply_cookie(sd_bus_message *, uint64_t *);
int sd_bus_message_get_type(sd_bus_message *, uint8_t *);
const char *sd_bus_message_get_path(sd_bus_message *);
const char *sd_bus_message_get_member(sd_bus_message *);
const sd_bus_error *sd_bus_message_get_error(sd_bus_message *);
int sd_bus_message_is_signal(sd_bus_message *, const char *, const char *);
int sd_bus_message_is_method_error(sd_bus_message *, const char *);
int sd_bus_message_has_signature(sd_bus_message *, const char *);
int sd_bus_message_set_auto_start(sd_bus_message *, int);
int sd_bus_message_set_allow_interactive_authorization(sd_bus_message *, int);
int sd_bus_message_append(sd_bus_message *, const char *, ...);
int sd_bus_message_open_container(sd_bus_message *, char, const char *);
int sd_bus_message_close_container(sd_bus_message *);
int sd_bus_message_read(sd_bus_message *, const char *, ...);
int sd_bus_message_read_array(sd_bus_message *, char, const void **, size_t *);
int sd_bus_message_enter_container(sd_bus_message *, char, const char *);
int sd_bus_message_exit_container(sd_bus_message *);
int sd_bus_message_skip(sd_bus_message *, const char *);
int sd_bus_message_at_end(sd_bus_message *, int);
#endif
