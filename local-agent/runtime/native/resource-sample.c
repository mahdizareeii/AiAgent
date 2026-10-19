#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <time.h>
#include <unistd.h>

/* Read-only telemetry for a sibling process owned by the calling runtime.
 * This helper never acquires a task port, changes a process or reads its data. */
int main(int argc, char **argv) {
    if (argc != 3 || strcmp(argv[1], "--pid") != 0 || argv[2][0] < '1' || argv[2][0] > '9') return 64;
    errno = 0;
    char *end = NULL;
    long parsed = strtol(argv[2], &end, 10);
    if (errno || !end || *end || parsed <= 0 || parsed > INT_MAX) return 64;
    pid_t pid = (pid_t) parsed;
    struct proc_bsdinfo info = {0};
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) ||
        info.pbi_ppid != (uint32_t) getppid() || info.pbi_uid != (uint32_t) geteuid()) return 77;
    struct rusage_info_v4 usage = {0};
    struct timespec now;
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *) &usage) != 0 ||
        clock_gettime(CLOCK_REALTIME, &now) != 0 || !usage.ri_resident_size || !usage.ri_phys_footprint) return 69;
    printf("{\"schemaVersion\":1,\"helperIdentity\":\"free-local-agent-resource-v1\",\"pid\":%d,\"parentPid\":%d,\"rssBytes\":%" PRIu64 ",\"physicalFootprintBytes\":%" PRIu64 ",\"sampledAtMilliseconds\":%" PRIu64 "}\n",
           pid, getppid(), usage.ri_resident_size, usage.ri_phys_footprint,
           (uint64_t) now.tv_sec * 1000 + (uint64_t) now.tv_nsec / 1000000);
    return 0;
}
