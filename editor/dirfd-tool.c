/* Directory-relative create, stat, and unlink.
   The checked directory is inherited as file descriptor 3.
   A name is one path component: a swapped parent path cannot redirect it.
*/
#if defined(__APPLE__)
#define _DARWIN_C_SOURCE
#endif
#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define DIR_FD 3

static int valid_name(const char *name) {
  if (name == NULL || name[0] == '\0') return 0;
  if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) return 0;
  if (strchr(name, '/') != NULL) return 0;
  return 1;
}

static const char *errname(int err) {
  if (err == EEXIST) return "EEXIST";
  if (err == ELOOP) return "ELOOP";
  if (err == ENOTDIR) return "ENOTDIR";
  if (err == ENOENT) return "ENOENT";
  if (err == ENAMETOOLONG) return "ENAMETOOLONG";
  if (err == EIO) return "EIO";
  return "EIO";
}

static void fail(int err) {
  fprintf(stderr, "%s\n", errname(err));
}

static void print_stat(const struct stat *st) {
  const char *kind = "other";
  if (S_ISLNK(st->st_mode)) kind = "lnk";
  else if (S_ISREG(st->st_mode)) kind = "reg";
  printf("%s %llu %llu\n", kind,
    (unsigned long long) st->st_dev,
    (unsigned long long) st->st_ino);
}

static int write_all(int fd, const char *buf, size_t len) {
  size_t off = 0;
  while (off < len) {
    ssize_t wrote = write(fd, buf + off, len - off);
    if (wrote < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (wrote == 0) {
      errno = EIO;
      return -1;
    }
    off += (size_t) wrote;
  }
  return 0;
}

static int creat_file(const char *name) {
  int flags = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;
#ifdef O_NONBLOCK
  flags |= O_NONBLOCK;
#endif
  int fd = openat(DIR_FD, name, flags, 0644);
  if (fd < 0) {
    fail(errno);
    return 1;
  }
  char buf[8192];
  for (;;) {
    ssize_t got = read(STDIN_FILENO, buf, sizeof buf);
    if (got < 0) {
      if (errno == EINTR) continue;
      fail(errno);
      close(fd);
      return 1;
    }
    if (got == 0) break;
    if (write_all(fd, buf, (size_t) got) != 0) {
      fail(errno);
      close(fd);
      return 1;
    }
  }
  if (fsync(fd) != 0) {
    fail(errno);
    close(fd);
    return 1;
  }
  struct stat st;
  if (fstat(fd, &st) != 0) {
    fail(errno);
    close(fd);
    return 1;
  }
  close(fd);
  print_stat(&st);
  return 0;
}

static int stat_file(const char *name) {
  struct stat st;
  if (fstatat(DIR_FD, name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) {
      printf("missing\n");
      return 0;
    }
    fail(errno);
    return 1;
  }
  print_stat(&st);
  return 0;
}

static int unlink_self(void) {
  struct stat opened;
  if (fstat(DIR_FD, &opened) != 0) {
    fail(errno);
    return 1;
  }
  char full[4096];
#if defined(__APPLE__)
  if (fcntl(DIR_FD, F_GETPATH, full) != 0) {
    fail(errno);
    return 1;
  }
#else
  ssize_t n = readlink("/proc/self/fd/" "3", full, sizeof full - 1);
  if (n < 0) {
    fail(errno);
    return 1;
  }
  full[n] = '\0';
  const char *suffix = " (deleted)";
  size_t len = strlen(full);
  size_t slen = strlen(suffix);
  if (len > slen && strcmp(full + len - slen, suffix) == 0) full[len - slen] = '\0';
#endif
  char *slash = strrchr(full, '/');
  if (slash == NULL || slash[1] == '\0') {
    fail(EIO);
    return 1;
  }
  *slash = '\0';
  const char *base = slash + 1;
  const char *dirpath = full[0] != '\0' ? full : "/";
  int dirfd = open(dirpath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (dirfd < 0) {
    fail(errno);
    return 1;
  }
  struct stat listed;
  if (fstatat(dirfd, base, &listed, AT_SYMLINK_NOFOLLOW) != 0
      || S_ISLNK(listed.st_mode)
      || listed.st_dev != opened.st_dev
      || listed.st_ino != opened.st_ino) {
    close(dirfd);
    printf("skip\n");
    return 0;
  }
  if (unlinkat(dirfd, base, 0) != 0) {
    int err = errno;
    close(dirfd);
    fail(err);
    return 1;
  }
  close(dirfd);
  printf("ok\n");
  return 0;
}

static int unlink_file(const char *name, const char *dev_text, const char *ino_text) {
  char *dev_end = NULL;
  char *ino_end = NULL;
  unsigned long long dev = strtoull(dev_text, &dev_end, 10);
  unsigned long long ino = strtoull(ino_text, &ino_end, 10);
  if (dev_end == dev_text || ino_end == ino_text || *dev_end != '\0' || *ino_end != '\0') {
    fail(EIO);
    return 1;
  }
  struct stat st;
  if (fstatat(DIR_FD, name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
    printf("skip\n");
    return 0;
  }
  if (S_ISLNK(st.st_mode)
      || (unsigned long long) st.st_dev != dev
      || (unsigned long long) st.st_ino != ino) {
    printf("skip\n");
    return 0;
  }
  if (unlinkat(DIR_FD, name, 0) != 0) {
    fail(errno);
    return 1;
  }
  printf("ok\n");
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 3) return 2;
  const char *cmd = argv[1];
  const char *name = argv[2];
  if (!valid_name(name)) return 2;
  if (strcmp(cmd, "unlink-self") == 0 && strcmp(name, "-") == 0) return unlink_self();
  if (strcmp(cmd, "creat") == 0) return creat_file(name);
  if (strcmp(cmd, "stat") == 0) return stat_file(name);
  if (strcmp(cmd, "unlink") == 0) {
    if (argc < 5) return 2;
    return unlink_file(name, argv[3], argv[4]);
  }
  return 2;
}
