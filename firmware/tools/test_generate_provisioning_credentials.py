#!/usr/bin/env python3

import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from generate_provisioning_credentials import is_android_srp_compatible


class AndroidSrpCompatibilityTest(unittest.TestCase):
    def test_rejects_known_leading_zero_hash_vector(self) -> None:
        self.assertFalse(is_android_srp_compatible("test-user", "test-password-463"))

    def test_accepts_regular_hash_vector(self) -> None:
        self.assertTrue(is_android_srp_compatible("test-user", "test-password-0"))


if __name__ == "__main__":
    unittest.main()
