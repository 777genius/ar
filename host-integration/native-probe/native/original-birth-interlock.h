#ifndef SR_ORIGINAL_BIRTH_INTERLOCK_H
#define SR_ORIGINAL_BIRTH_INTERLOCK_H
#include <stdatomic.h>
#include <stdint.h>
#include <linux/futex.h>
/* Mechanism DATA, not an Origin/role constructor. Only the native original cell
 * can supply this inherited shared word to its born Creator and close lane. */
struct np_birth_interlock { _Alignas(8) unsigned char storage[128]; };
void np_birth_interlock_init(struct np_birth_interlock *);
int np_birth_interlock_take(struct np_birth_interlock *,uint64_t absolute_monotonic_end);
int np_birth_interlock_drop(struct np_birth_interlock *);
int np_birth_interlock_owned(const struct np_birth_interlock *);
#endif
