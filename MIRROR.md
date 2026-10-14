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

## Reviewed source synchronization

The October 2026 synchronization uses reviewed source commit
`f97607a56c2a5e1c39cd98572beb858525eb82b2`, tree
`d2966ece9dede4b1aeba9c07210e975f74450949`. It copies tracked source files only;
private Git objects, commit ancestry, runtime state and credentials are excluded.
The public Apache license, security policy and secret-scanning configuration are
preserved. Package metadata points to this repository; package publishing
workflows remain excluded. The CI observer mount gate keeps the same executable
body on a stock Ubuntu 24.04 runner.
