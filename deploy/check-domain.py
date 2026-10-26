#!/usr/bin/env python3
"""Check domain occupancy without printing Nginx config (it may contain secrets)."""
import fnmatch
import re
import subprocess
import sys
domain = sys.argv[1].lower()
result = subprocess.run(['nginx', '-T'], check=True, capture_output=True, text=True)
for declaration in re.findall(r'\bserver_name\s+([^;]+);', result.stdout):
    for name in declaration.split():
        name = name.lower()
        if name.startswith('~'):
            sys.exit('Existing regex server_name requires manual overlap review before initialization')
        if name == domain or fnmatch.fnmatchcase(domain, name) or (name.startswith('.') and (domain == name[1:] or domain.endswith(name))):
            sys.exit('Requested NetPan domain is already covered by an existing Nginx site')
print('No existing Nginx server_name overlaps the requested NetPan domain')
