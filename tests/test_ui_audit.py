import importlib.util
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ui_audit.py"
spec = importlib.util.spec_from_file_location("ui_audit", SCRIPT)
ui_audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui_audit)


class UiAuditPackagingTests(unittest.TestCase):
    def test_sensitive_url_values_are_redacted(self):
        self.assertEqual(
            ui_audit.safe_url("https://example.test/a?campaign=ok&access_token=private"),
            "https://example.test/a?campaign=ok&access_token=%5BREDACTED%5D",
        )

    def test_secret_patterns_are_redacted(self):
        dummy = "abcdefghijkl" + "mnopqrstuvwxyz12345"
        value = ui_audit.redact("Authorization: Bearer " + dummy)
        self.assertIn("[REDACTED]", value)
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz12345", value)

    def test_zip_is_closed_and_readable_after_temp_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            zip_path = Path(temp) / "audit.zip"
            with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("lantern-ui-audit/README.md", "review bundle")
            with zipfile.ZipFile(zip_path) as archive:
                self.assertIsNone(archive.testzip())
                self.assertEqual(archive.read("lantern-ui-audit/README.md"), b"review bundle")
        self.assertFalse(Path(temp).exists())

    def test_owned_process_group_is_stopped(self):
        process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
        try:
            ui_audit.stop_owned_process(process)
            self.assertIsNotNone(process.poll())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


if __name__ == "__main__":
    unittest.main()
