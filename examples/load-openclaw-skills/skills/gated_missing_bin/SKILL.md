---
name: gated_missing_bin
description: This skill should be skipped at load time (missing binary gate).
metadata:
  openclaw:
    requires:
      bins: ["intentionally-missing-binary-demo"]
---

# Should not load

If you see this text in context, gating failed.
