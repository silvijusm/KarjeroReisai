#!/usr/bin/env python3
"""Fail CI on missing translations or incompatible Android format arguments."""
from pathlib import Path
import re
import xml.etree.ElementTree as ET
root = Path(__file__).resolve().parents[1] / 'app/src/main/res'
def strings(folder):
    return {e.attrib['name']: e.text or '' for e in ET.parse(root / folder / 'strings.xml').getroot()}
base = strings('values')
for lang in ['en', 'ru', 'lv', 'et', 'pl']:
    translated = strings('values-' + lang)
    assert base.keys() == translated.keys(), f'Missing or extra strings: {lang}'
    for key, value in base.items():
        tokens = lambda s: sorted(re.findall(r'%\d+\$[sdf]', s))
        assert tokens(value) == tokens(translated[key]), f'Format mismatch: {lang}/{key}'
        assert translated[key].strip(), f'Empty: {lang}/{key}'
print(f'All {len(base)} strings are present with matching arguments in six languages.')
