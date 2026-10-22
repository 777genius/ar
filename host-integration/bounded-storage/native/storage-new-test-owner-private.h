#ifndef STORAGE_NEW_TEST_OWNER_PRIVATE_H
#define STORAGE_NEW_TEST_OWNER_PRIVATE_H
/* Private to the exact ELF translation unit. No exported authority DTO. */
#define TEST_CLAIM ".bounded-storage-new-test-owner-v1"
#define TEST_CHANNELS 4
#define TEST_REQUEST_MAX 2048
#define TEST_POLICY_MAX 512
struct test_claim {
  uint64_t magic, complete, root_dev, root_ino, root_mount, namespace_ino;
  uint64_t control_dev, control_ino, fence_dev, fence_ino;
  uint64_t backing_dev, backing_ino, backing_bytes, loop_dev;
  uint64_t helper_dev, helper_ino, tool_dev, tool_ino, policy_dev, policy_ino;
  char machine[33], boot[37], filesystem[37], helper_digest[65], tool_digest[65], policy_digest[65];
};
struct test_issue {
  uint64_t revision, project, q_bytes, q_inodes, physical, e_bytes, e_inodes;
  char job[64], generation[37], operation[37], receipt[65], digest[65];
  char request[TEST_REQUEST_MAX];
};
static bool test_mode;
static int test_claim_fd = -1, test_owner_channel = -1;
static struct test_claim test_claim;
static struct test_issue test_current, test_authorized;
static bool test_capability, test_pending;
static void test_live(void);
static void test_frame(size_t length, const char *digest);
static void test_publication(const char *old, size_t old_length, const char *next, size_t next_length);
static void test_after_publication(void);
static void test_prepare_current(const char *generation, const char *operation, const char *digest);
static int new_test_owner(int argc, char **argv);
#endif
