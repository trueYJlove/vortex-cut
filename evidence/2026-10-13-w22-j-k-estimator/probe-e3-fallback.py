"""NC-3 重做：构造**必然触发 E3 回退分支**的输入，验证回退语义有区分力。"""
import sys

sys.path.insert(0, "tools/quality_eval")
sys.path.insert(0, "services/core/src")

import numpy as np

from diarization_k_estimators import e0_distance_mixture, e3_split_consistency  # noqa: E402

# 构造：前半"很可分"（应估 2）、后半"很不可分"（应估 ≥4）
rng = np.random.default_rng(5)
dim = 192


def cluster(k, per, spread):
    c = rng.normal(size=(k, dim))
    c /= np.linalg.norm(c, axis=1, keepdims=True)
    v = np.vstack([x + rng.normal(scale=spread, size=(per, dim)) for x in c])
    return v / np.linalg.norm(v, axis=1, keepdims=True)


# 扫一组构造，找到两半差异 >1 的（= 回退分支可达）
found = None
for seed in range(40):
    rng = np.random.default_rng(seed)
    v = np.vstack([cluster(2, 8, 0.03), cluster(6, 8, 0.30)])
    h = v.shape[0] // 2
    a, b = e0_distance_mixture(v[:h]), e0_distance_mixture(v[h:])
    if abs(a - b) > 1:
        found = (seed, a, b, e3_split_consistency(v), e0_distance_mixture(v))
        break

print("回退分支可达:", found is not None)
if found:
    seed, a, b, e3_full, e0_full = found
    print("  seed=%d  half1=%d half2=%d  E3=%d  E0(全集)=%d"
          % (seed, a, b, e3_full, e0_full))
    print("  => 回退生效判定: E3 == E0(全集)? %s" % (e3_full == e0_full))
