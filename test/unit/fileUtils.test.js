import { describe, expect, it, beforeAll } from 'vitest';

let u;
beforeAll(async () => {
  globalThis.window = { fsApi: { platform: 'darwin' } };
  u = await import('../../src/lib/fileUtils.js');
});

describe('formatSize (macOS uses powers of 1000, like Finder)', () => {
  it('formats bytes, KB, MB, GB, TB', () => {
    expect(u.formatSize(999)).toBe('999 B');
    expect(u.formatSize(1000)).toBe('1.00 KB');
    expect(u.formatSize(245_107_195_904)).toBe('245 GB'); // System Settings shows 245.11 GB
    expect(u.formatSize(49_474_456_754)).toBe('49.5 GB'); // Finder "available"
    expect(u.formatSize(2_500_000)).toBe('2.50 MB');
    expect(u.formatSize(null)).toBe('');
  });
});

describe('remote (phone / FTP) paths', () => {
  const ftp = 'ftp://abc123';
  it('recognises remote paths', () => {
    expect(u.isRemotePath('ftp://abc/x')).toBe(true);
    expect(u.isRemotePath('mtp://phone/Internal/DCIM')).toBe(true);
    expect(u.isRemotePath('/Users/me')).toBe(false);
    expect(u.isRemotePath('C:\\Users')).toBe(false);
  });
  it('dirname / basename / isRootPath', () => {
    expect(u.dirname(`${ftp}/a/b`)).toBe(`${ftp}/a`);
    expect(u.dirname(`${ftp}/a`)).toBe(`${ftp}/`);
    expect(u.dirname(`${ftp}/`)).toBe(`${ftp}/`);
    expect(u.basename('mtp://phone/Internal shared storage/DCIM/Camera')).toBe('Camera');
    expect(u.isRootPath('mtp://phone/')).toBe(true);
    expect(u.isRootPath('mtp://phone/Internal shared storage')).toBe(false);
  });
  it('breadcrumbs start at the connection name', () => {
    u.remoteNames.phone = 'Moto';
    const parts = u.splitPath('mtp://phone/Internal/DCIM');
    expect(parts.map((p) => p.name)).toEqual(['Moto', 'Internal', 'DCIM']);
    expect(parts[2].path).toBe('mtp://phone/Internal/DCIM');
    expect(parts[0].path).toBe('mtp://phone/');
  });
  it('joinPath keeps the scheme', () => {
    expect(u.joinPath('mtp://phone/Internal', 'x.jpg')).toBe('mtp://phone/Internal/x.jpg');
  });
});

describe('archives', () => {
  it('detects archive names', () => {
    expect(u.isArchiveName('a.zip')).toBe(true);
    expect(u.isArchiveName('a.tar.gz')).toBe(true);
    expect(u.isArchiveName('a.txt')).toBe(false);
  });
});
