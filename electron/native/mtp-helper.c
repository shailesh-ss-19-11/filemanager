/*
 * mtp-helper: tiny libmtp front-end used by the file manager to browse an Android phone over USB (MTP).
 *
 *   mtp-helper detect   print one "DEV<TAB>vendor<TAB>product" line per attached MTP device, then exit
 *   mtp-helper serve    open the first device and answer tab-separated commands on stdin
 *
 * Every request line is "<reqid>\t<op>\t<args...>"; every reply line starts with the same reqid and
 * ends with either "OK\t<value>" or "ERR\t<message>". "D\t..." lines carry rows of data in between.
 */
#include <libmtp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>

static LIBMTP_mtpdevice_t *dev = NULL;

static void clean(char *s) {
  for (; s && *s; s++)
    if (*s == '\t' || *s == '\n' || *s == '\r') *s = ' ';
}

static void err(const char *id, const char *fallback) {
  const char *msg = fallback;
  if (dev) {
    LIBMTP_error_t *e = LIBMTP_Get_Errorstack(dev);
    if (e && e->error_text) msg = e->error_text;
  }
  char buf[512];
  snprintf(buf, sizeof buf, "%s", msg);
  clean(buf);
  printf("%s\tERR\t%s\n", id, buf);
  if (dev) LIBMTP_Clear_Errorstack(dev);
  fflush(stdout);
}

static void ok(const char *id, const char *val) {
  printf("%s\tOK\t%s\n", id, val ? val : "");
  fflush(stdout);
}

static int detect(void) {
  LIBMTP_raw_device_t *raw = NULL;
  int n = 0;
  LIBMTP_Init();
  LIBMTP_error_number_t e = LIBMTP_Detect_Raw_Devices(&raw, &n);
  if (e != LIBMTP_ERROR_NONE || n == 0) return 0;
  for (int i = 0; i < n; i++) {
    char v[128], p[128];
    snprintf(v, sizeof v, "%s", raw[i].device_entry.vendor ? raw[i].device_entry.vendor : "");
    snprintf(p, sizeof p, "%s", raw[i].device_entry.product ? raw[i].device_entry.product : "");
    clean(v);
    clean(p);
    printf("DEV\t%s\t%s\n", v, p);
  }
  free(raw);
  return 0;
}

static int open_device(void) {
  LIBMTP_raw_device_t *raw = NULL;
  int n = 0;
  LIBMTP_Init();
  for (int attempt = 0; attempt < 8 && !dev; attempt++) {
    if (LIBMTP_Detect_Raw_Devices(&raw, &n) == LIBMTP_ERROR_NONE && n > 0) {
      dev = LIBMTP_Open_Raw_Device_Uncached(&raw[0]);
      free(raw);
      raw = NULL;
    }
    if (!dev) {
#ifdef __APPLE__
      /* macOS' own camera service (ptpcamerad) grabs phones the moment they are free; it restarts by itself */
      if (system("/usr/bin/killall -9 ptpcamerad >/dev/null 2>&1") != 0) { /* not running: fine */ }
#endif
      sleep(1);
    }
  }
  return dev != NULL;
}

static uint64_t last_report = 0;
static int progress_cb(const uint64_t sent, const uint64_t total, void const *const data) {
  /* report roughly every 512 KB so the app can draw a progress bar without flooding the pipe */
  if (sent == total || sent - last_report >= 512 * 1024 || sent < last_report) {
    printf("%s\tP\t%llu\t%llu\n", (const char *)data, (unsigned long long)sent, (unsigned long long)total);
    fflush(stdout);
    last_report = sent;
  }
  return 0;
}

static void do_storages(const char *id) {
  if (LIBMTP_Get_Storage(dev, LIBMTP_STORAGE_SORTBY_NOTSORTED) < 0) return err(id, "Could not read the phone's storage. Unlock the phone and allow access.");
  for (LIBMTP_devicestorage_t *s = dev->storage; s; s = s->next) {
    char d[256];
    snprintf(d, sizeof d, "%s", s->StorageDescription ? s->StorageDescription : "Storage");
    clean(d);
    printf("%s\tD\t%u\t%s\t%llu\t%llu\n", id, s->id, d, (unsigned long long)s->MaxCapacity,
           (unsigned long long)s->FreeSpaceInBytes);
  }
  ok(id, "");
}

static void do_list(const char *id, uint32_t storage, uint32_t parent) {
  LIBMTP_file_t *files = LIBMTP_Get_Files_And_Folders(dev, storage, parent);
  if (!files && LIBMTP_Get_Errorstack(dev)) return err(id, "Could not list this folder.");
  while (files) {
    LIBMTP_file_t *f = files;
    files = files->next;
    char name[512];
    snprintf(name, sizeof name, "%s", f->filename ? f->filename : "");
    clean(name);
    printf("%s\tD\t%u\t%c\t%llu\t%lld\t%s\n", id, f->item_id, f->filetype == LIBMTP_FILETYPE_FOLDER ? 'd' : 'f',
           (unsigned long long)f->filesize, (long long)f->modificationdate, name);
    LIBMTP_destroy_file_t(f);
  }
  ok(id, "");
}

static void do_thumb(const char *id, uint32_t item) {
  static const char tbl[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  unsigned char *data = NULL;
  unsigned int size = 0;
  if (LIBMTP_Get_Thumbnail(dev, item, &data, &size) != 0 || !data || !size) return err(id, "No thumbnail.");
  printf("%s\tD\t", id);
  for (unsigned int i = 0; i < size; i += 3) {
    unsigned int v = data[i] << 16;
    if (i + 1 < size) v |= data[i + 1] << 8;
    if (i + 2 < size) v |= data[i + 2];
    putchar(tbl[(v >> 18) & 63]);
    putchar(tbl[(v >> 12) & 63]);
    putchar(i + 1 < size ? tbl[(v >> 6) & 63] : '=');
    putchar(i + 2 < size ? tbl[v & 63] : '=');
  }
  putchar('\n');
  free(data);
  ok(id, "");
}

static void handle(char *line) {
  char *save = NULL;
  char *id = strtok_r(line, "\t", &save);
  char *op = strtok_r(NULL, "\t", &save);
  if (!id || !op) return;
  char *a = strtok_r(NULL, "\t", &save);
  char *b = strtok_r(NULL, "\t", &save);
  char *c = strtok_r(NULL, "\t", &save);
  char *d = strtok_r(NULL, "\t", &save);

  if (!strcmp(op, "storages")) return do_storages(id);
  if (!strcmp(op, "thumb") && a) return do_thumb(id, (uint32_t)strtoul(a, NULL, 10));
  if (!strcmp(op, "list") && a && b) return do_list(id, (uint32_t)strtoul(a, NULL, 10), (uint32_t)strtoul(b, NULL, 10));
  if (!strcmp(op, "get") && a && b) {
    if ((last_report = 0, LIBMTP_Get_File_To_File(dev, (uint32_t)strtoul(a, NULL, 10), b, progress_cb, id)) != 0) return err(id, "Could not copy the file from the phone.");
    return ok(id, "");
  }
  if (!strcmp(op, "send") && a && b && c && d) { /* storage parent localpath name */
    FILE *fp = fopen(c, "rb");
    if (!fp) return err(id, "Could not read the local file.");
    fseek(fp, 0, SEEK_END);
    long long size = ftell(fp);
    fclose(fp);
    LIBMTP_file_t *f = LIBMTP_new_file_t();
    f->filename = strdup(d);
    f->filesize = (uint64_t)size;
    f->parent_id = (uint32_t)strtoul(b, NULL, 10);
    f->storage_id = (uint32_t)strtoul(a, NULL, 10);
    f->filetype = LIBMTP_FILETYPE_UNKNOWN;
    int r = (last_report = 0, LIBMTP_Send_File_From_File(dev, c, f, progress_cb, id));
    char v[32];
    snprintf(v, sizeof v, "%u", f->item_id);
    LIBMTP_destroy_file_t(f);
    if (r != 0) return err(id, "Could not copy the file to the phone (is there enough space?).");
    return ok(id, v);
  }
  if (!strcmp(op, "mkdir") && a && b && c) { /* storage parent name */
    uint32_t nid = LIBMTP_Create_Folder(dev, c, (uint32_t)strtoul(b, NULL, 10), (uint32_t)strtoul(a, NULL, 10));
    if (!nid) return err(id, "Could not create the folder.");
    char v[32];
    snprintf(v, sizeof v, "%u", nid);
    return ok(id, v);
  }
  if (!strcmp(op, "del") && a) {
    if (LIBMTP_Delete_Object(dev, (uint32_t)strtoul(a, NULL, 10)) != 0) return err(id, "Could not delete this item.");
    return ok(id, "");
  }
  if (!strcmp(op, "rename") && a && b) {
    LIBMTP_file_t *f = LIBMTP_Get_Filemetadata(dev, (uint32_t)strtoul(a, NULL, 10));
    if (!f) return err(id, "Could not find this item on the phone.");
    int r = LIBMTP_Set_File_Name(dev, f, b);
    LIBMTP_destroy_file_t(f);
    if (r != 0) return err(id, "The phone refused to rename this item.");
    return ok(id, "");
  }
  err(id, "Unknown command.");
}

static int serve(void) {
  if (!open_device()) {
    printf("FAIL\tCould not open the phone. Unlock it, choose File transfer, and close other apps that use it (Android File Transfer, MacDroid, Chrome).\n");
    return 1;
  }
  char *name = LIBMTP_Get_Modelname(dev);
  char *man = LIBMTP_Get_Manufacturername(dev);
  char label[256];
  /* models often repeat the maker ("motorola edge 50 neo" by "motorola"): don't print it twice */
  int dup = man && name && strncasecmp(name, man, strlen(man)) == 0;
  snprintf(label, sizeof label, "%s%s%s", (man && !dup) ? man : "", (man && !dup && name) ? " " : "", name ? name : "Android phone");
  clean(label);
  printf("READY\t%s\n", label);
  fflush(stdout);
  char *line = NULL;
  size_t cap = 0;
  ssize_t len;
  while ((len = getline(&line, &cap, stdin)) > 0) {
    while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = 0;
    handle(line);
  }
  LIBMTP_Release_Device(dev);
  return 0;
}

int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "detect")) return detect();
  if (argc > 1 && !strcmp(argv[1], "serve")) return serve();
  fprintf(stderr, "usage: mtp-helper detect|serve\n");
  return 2;
}
