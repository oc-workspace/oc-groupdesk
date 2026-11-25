import importlib.util,io,json,tarfile,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def module(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
manage=module('gdmanage',ROOT/'distribution/manage.py')
manage_macos=module('gdmanage_macos',ROOT/'distribution/manage-macos.py')
package=module('gdpackage',ROOT/'scripts/package-standalone.py')
class Safety(unittest.TestCase):
 def test_archive_traversal_absolute_link_and_device_rejected(self):
  for mod in (manage,manage_macos):
   for name,kind in [('../outside','file'),('/tmp/outside','file'),('escape','symlink'),('escape','hardlink'),('device','device')]:
    with self.subTest(mod=mod.__name__,name=name,kind=kind),tempfile.TemporaryDirectory() as temp:
     data=io.BytesIO()
     with tarfile.open(fileobj=data,mode='w') as tar:
      m=tarfile.TarInfo(name);m.type={'symlink':tarfile.SYMTYPE,'hardlink':tarfile.LNKTYPE,'device':tarfile.CHRTYPE}.get(kind,tarfile.REGTYPE);m.linkname='/outside';tar.addfile(m)
     data.seek(0)
     with tarfile.open(fileobj=data) as tar:self.assertRaises(RuntimeError,mod.extract,tar,Path(temp))
 def test_manifest_detects_modification_and_rejects_symlinks(self):
  for mod in (manage,manage_macos):
   with self.subTest(mod=mod.__name__),tempfile.TemporaryDirectory() as temp:
    p=Path(temp);(p/'data').write_text('synthetic');mod.json_write(p/'MANIFEST.json',mod.manifest(p));mod.verify(p)
    (p/'data').write_text('modified');self.assertRaises(RuntimeError,mod.verify,p)
    (p/'link').symlink_to('/etc/passwd');self.assertRaises(RuntimeError,mod.manifest,p)
 def test_allowlist_excludes_private_and_retains_download_dependencies(self):
  for name in ['.env','data/messages.json','skills/gt-banter/SKILL.md','docs/progress/2026-11-20.md','.backups/x.key','integration/test_private.py']:
   self.assertFalse(package.selected(ROOT/name),name)
  for name in ['server/index.ts','distribution/manage-macos.py','distribution/README-macos.md','integration/local-collector/macos-gui/LICENSE','integration/participation/matcher.d.mts','scripts/provision-runtime-host.ts','integration/local-collector/macos-gui/continuous/test_stream.py','integration/local-collector/macos-gui/continuous/README.md']:
   self.assertTrue(package.selected(ROOT/name),name)
 def test_credential_scan(self):
  self.assertIsNotNone(package.DENY.search('sk-'+'a'*40));self.assertIsNone(package.DENY.search('synthetic-placeholder'))
 def test_macos_node_version_check(self):
  self.assertGreaterEqual(manage_macos.parse_node_version('v22.13.0'),(22,13,0))
  self.assertGreaterEqual(manage_macos.parse_node_version('v24.22.3'),(22,13,0))
  self.assertLess(manage_macos.parse_node_version('v20.19.0'),(22,13,0))
if __name__=='__main__':unittest.main()
