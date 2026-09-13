"""Portable lossless source snapshot, without environment files or rebuildable caches."""
import pathlib
import sys
import tarfile

source = pathlib.Path(sys.argv[1]).resolve()
destination = pathlib.Path(sys.argv[2]).resolve()
excluded = {"node_modules", ".next", "__pycache__"}

def include(info):
    parts = pathlib.PurePosixPath(info.name).parts
    if any(part in excluded or part.startswith(".env") for part in parts):
        return None
    return info

with tarfile.open(destination, "w:gz", compresslevel=1, format=tarfile.PAX_FORMAT) as archive:
    archive.add(source, arcname=source.name, filter=include)
