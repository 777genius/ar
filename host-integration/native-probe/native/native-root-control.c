#include "native-root-control.h"
#include <errno.h>
#include <string.h>
static uint64_t read64(const unsigned char *p) { uint64_t n = 0; for (unsigned i = 0; i < 8; i++) n = (n << 8) | p[i]; return n; }
static size_t read32(const unsigned char *p) { size_t n = 0; for (unsigned i = 0; i < 4; i++) n = (n << 8) | p[i]; return n; }
static int hex(const unsigned char *p, size_t n) { for (size_t i = 0; i < n; i++) if (!((p[i] >= '0' && p[i] <= '9') || (p[i] >= 'a' && p[i] <= 'f'))) return -1; return 0; }
static int header(const unsigned char *p, size_t n, const char *magic) {
  if (n < NP_ROOT_WIRE_HEADER || n > NP_ROOT_WIRE_MAX || memcmp(p, magic, 4) || p[4] != 3 || p[5] < 1 || p[5] > 3 || p[7] || read32(p + 8) != n - NP_ROOT_WIRE_HEADER || !read64(p + 12)) { errno = EPROTO; return -1; }
  return 0;
}
int np_root_request_decode_v3(const unsigned char *p, size_t n, struct np_root_request_v3 *out) {
  if (!p || !out || header(p, n, "NPR3") || p[6] || n < 118 || n > 149 || hex(p + 20, 64) || hex(p + 84, 32)) { errno = EPROTO; return -1; }
  size_t job = p[116];
  if (!job || job > 32 || n != 117 + job || p[117] < 'a' || p[117] > 'z') { errno = EPROTO; return -1; }
  for (size_t i = 0; i < job; i++) if (!((p[117 + i] >= 'a' && p[117 + i] <= 'z') || (p[117 + i] >= '0' && p[117 + i] <= '9') || p[117 + i] == '-')) { errno = EPROTO; return -1; }
  memset(out, 0, sizeof *out); out->operation = (enum np_root_operation_v3)p[5]; out->correlation = read64(p + 12);
  memcpy(out->digest, p + 20, 64); memcpy(out->machine, p + 84, 32); memcpy(out->job, p + 117, job); return 0;
}
int np_root_response_header_v3(unsigned char out[NP_ROOT_WIRE_HEADER], const struct np_root_request_v3 *r, unsigned status, size_t length) {
  if (!out || !r || r->operation < NP_ROOT_START || r->operation > NP_ROOT_STOP || !r->correlation || status > 1 || length > NP_ROOT_WIRE_MAX - NP_ROOT_WIRE_HEADER) { errno = EINVAL; return -1; }
  memset(out, 0, NP_ROOT_WIRE_HEADER); memcpy(out, "NPD3", 4); out[4] = 3; out[5] = (unsigned char)r->operation; out[6] = (unsigned char)status;
  for (unsigned i = 0; i < 4; i++) out[11 - i] = (unsigned char)(length >> (8 * i));
  for (unsigned i = 0; i < 8; i++) out[19 - i] = (unsigned char)(r->correlation >> (8 * i));
  return 0;
}
int np_root_response_check_v3(const unsigned char *p, size_t n, const struct np_root_request_v3 *r) {
  if (!p || !r || header(p, n, "NPD3") || p[6] > 1 || p[5] != (unsigned)r->operation || read64(p + 12) != r->correlation) { errno = EPROTO; return -1; }
  return 0;
}
