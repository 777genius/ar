#ifndef SR_NATIVE_ROOT_CONTROL_V3_H
#define SR_NATIVE_ROOT_CONTROL_V3_H
#include <stddef.h>
#include <stdint.h>
#define NP_ROOT_WIRE_HEADER 20
#define NP_ROOT_WIRE_MAX 65536
#ifndef NP_ROOT_DIRECTORY
#define NP_ROOT_DIRECTORY "/run/subscription-runtime/native-probe"
#endif
#ifndef NP_ROOT_SOCKET
#define NP_ROOT_SOCKET "/run/subscription-runtime/native-probe/control.sock"
#endif
enum np_root_operation_v3 { NP_ROOT_START = 1, NP_ROOT_STATUS = 2, NP_ROOT_STOP = 3 };
struct np_root_request_v3 { enum np_root_operation_v3 operation; uint64_t correlation; char digest[65], machine[33], job[33]; };
/* Explicit byte serialization: no C struct padding, handles or owning fields. */
int np_root_request_decode_v3(const unsigned char *bytes, size_t length, struct np_root_request_v3 *out);
int np_root_response_header_v3(unsigned char out[NP_ROOT_WIRE_HEADER], const struct np_root_request_v3 *request, unsigned status, size_t length);
int np_root_response_check_v3(const unsigned char *bytes, size_t length, const struct np_root_request_v3 *request);
#endif
