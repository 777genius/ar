#include "native-root-control.h"
#include <stdio.h>
#include <string.h>
/* DATA codec fixture only: no registry, socket, owner or launch code linked. */
int main(void) {
  unsigned char bytes[150]; size_t n = fread(bytes, 1, sizeof bytes, stdin);
  struct np_root_request_v3 request;
  if (ferror(stdin) || np_root_request_decode_v3(bytes, n, &request)) return 77;
  if (request.operation != NP_ROOT_STATUS || strcmp(request.job, "sandbox") || request.correlation != UINT64_C(1)) return 77;
  unsigned char header[NP_ROOT_WIRE_HEADER];
  if (np_root_response_header_v3(header, &request, 1, 0) || np_root_response_check_v3(header, sizeof header, &request)) return 77;
  return fwrite(header, 1, sizeof header, stdout) == sizeof header ? 0 : 77;
}
