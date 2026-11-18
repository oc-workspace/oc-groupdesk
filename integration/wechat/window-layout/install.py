"""Install the reviewed window-layout patch on the matching Linux sender."""
import argparse
import hashlib
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

PACKAGE = Path(__file__).resolve().parent
BASELINE = {
    'client.py': 'eef6a529985c7ee2537711bac692f550642f84b35297ac492870feb1a40d877a',
    'input.py': '08fe72fd0cd7556579d768160deb23ef788f07210f13e696b0e6f751b5a08fcb',
}
RESULT = {
    'client.py': '1994d3a1206af2725df260760115e4821552b90a8d957e9f5b6f074c48c1cb14',
    'input.py': 'c541e3d7c5548a41f9110cb15fa64f588d7cca78fe6947007d0aebfbdda49652',
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def install(source, output):
    actual = {name: digest(source / name) for name in BASELINE}
    if actual not in (BASELINE, RESULT):
        raise ValueError('Sender source differs from the reviewed baseline')
    with TemporaryDirectory() as directory:
        staged = Path(directory)
        for name in BASELINE:
            (staged / name).write_bytes((source / name).read_bytes())
        if actual == BASELINE:
            subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-i', str(PACKAGE/'window-layout.patch')],
                           cwd=staged, check=True)
        for name in BASELINE:
            assert digest(staged / name) == RESULT[name]
            compile((staged / name).read_bytes(), name, 'exec')
        output.mkdir(parents=True, exist_ok=True)
        for name in BASELINE:
            (output / name).write_bytes((staged / name).read_bytes())


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('sender_source', type=Path)
    parser.add_argument('staging_output', type=Path)
    args = parser.parse_args()
    install(args.sender_source, args.staging_output)
