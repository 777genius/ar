# Subscription Runtime public source

`777genius/ar` is the public source repository for reproducible Subscription
Runtime builds. Its source tree is synchronized from the current reviewed
runtime tree without importing private Git history.

- Consumers must pin a full reviewed commit SHA and build that source.
- Package publication remains temporarily owned by
  `vioxen/subscription-runtime` while existing consumers are migrated.
- This repository intentionally contains no package-publishing workflow.
- Existing tags are retained so previously published builds remain
  reproducible.
