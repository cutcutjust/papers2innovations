#include <mach-o/dyld.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  char executable_path[PATH_MAX];
  uint32_t path_size = sizeof(executable_path);
  if (_NSGetExecutablePath(executable_path, &path_size) != 0) {
    fprintf(stderr, "paper engine launcher path is too long\n");
    return 1;
  }

  char *separator = strrchr(executable_path, '/');
  if (separator == NULL) {
    fprintf(stderr, "cannot locate the paper engine resources\n");
    return 1;
  }
  *separator = '\0';

#if defined(__arm64__)
  const char *engine_name = "p2i-paper-engine-arm64";
#elif defined(__x86_64__)
  const char *engine_name = "p2i-paper-engine-x86_64";
#else
#error Unsupported macOS architecture
#endif

  char engine_path[PATH_MAX];
  int written = snprintf(engine_path, sizeof(engine_path),
                         "%s/../Resources/macos/%s", executable_path,
                         engine_name);
  if (written < 0 || (size_t)written >= sizeof(engine_path)) {
    fprintf(stderr, "paper engine resource path is too long\n");
    return 1;
  }

  char **engine_argv = calloc((size_t)argc + 1, sizeof(char *));
  if (engine_argv == NULL) {
    perror("cannot allocate paper engine arguments");
    return 1;
  }
  engine_argv[0] = engine_path;
  for (int index = 1; index < argc; index++) {
    engine_argv[index] = argv[index];
  }

  execv(engine_path, engine_argv);
  perror("cannot start the paper engine");
  free(engine_argv);
  return 1;
}
