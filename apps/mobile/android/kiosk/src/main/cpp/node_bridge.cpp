// Starts Node (libnode.so) on the calling thread: the Android side of Electron's
// utilityProcess.fork (ADR 0029). Node can start only once per process, so ServerService runs
// in its own process and that process ends when Node does.
#include <android/log.h>
#include <jni.h>
#include <pthread.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace node {
int Start(int argc, char* argv[]);
}

namespace {

const char* const kTag = "PmpServer";
int g_pipe[2];

// Node's stdout and stderr (the server's log lines) go to logcat, one entry per line.
void* PumpOutput(void*) {
  char buf[4096];
  std::string line;
  ssize_t n;
  while ((n = read(g_pipe[0], buf, sizeof buf)) > 0) {
    line.append(buf, static_cast<size_t>(n));
    size_t end;
    while ((end = line.find('\n')) != std::string::npos) {
      __android_log_write(ANDROID_LOG_INFO, kTag, line.substr(0, end).c_str());
      line.erase(0, end + 1);
    }
    if (line.size() > 4000) {  // logcat's entry limit; flush a very long line in parts
      __android_log_write(ANDROID_LOG_INFO, kTag, line.c_str());
      line.clear();
    }
  }
  return nullptr;
}

void RedirectOutput() {
  setvbuf(stdout, nullptr, _IONBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  if (pipe(g_pipe) != 0) return;
  dup2(g_pipe[1], STDOUT_FILENO);
  dup2(g_pipe[1], STDERR_FILENO);
  pthread_t thread;
  if (pthread_create(&thread, nullptr, PumpOutput, nullptr) == 0) pthread_detach(thread);
}

std::string ToString(JNIEnv* env, jstring value) {
  const char* chars = env->GetStringUTFChars(value, nullptr);
  std::string result(chars);
  env->ReleaseStringUTFChars(value, chars);
  return result;
}

}  // namespace

// NodeRuntime.start(String[] args, String[] env, String cwd): sets each "NAME=value" in env,
// changes to cwd, and runs Node with args (args[0] is the program name). Blocks until Node
// exits, and returns its exit code.
extern "C" JNIEXPORT jint JNICALL Java_com_pocketmoneypal_kiosk_NodeRuntime_start(
    JNIEnv* env, jclass, jobjectArray jargs, jobjectArray jenv, jstring jcwd) {
  for (jsize i = 0; i < env->GetArrayLength(jenv); i++) {
    std::string pair = ToString(env, static_cast<jstring>(env->GetObjectArrayElement(jenv, i)));
    size_t eq = pair.find('=');
    if (eq != std::string::npos) setenv(pair.substr(0, eq).c_str(), pair.c_str() + eq + 1, 1);
  }
  std::string cwd = ToString(env, jcwd);
  if (chdir(cwd.c_str()) != 0) __android_log_print(ANDROID_LOG_WARN, kTag, "chdir %s failed", cwd.c_str());

  // libuv expects argv's strings in one contiguous block (it reuses it for the process
  // title), and Node keeps pointers into it for as long as it runs: never freed.
  std::vector<std::string> args;
  for (jsize i = 0; i < env->GetArrayLength(jargs); i++) {
    args.push_back(ToString(env, static_cast<jstring>(env->GetObjectArrayElement(jargs, i))));
  }
  size_t size = 0;
  for (const auto& a : args) size += a.size() + 1;
  char* block = static_cast<char*>(calloc(size, 1));
  char** argv = static_cast<char**>(calloc(args.size() + 1, sizeof(char*)));
  char* p = block;
  for (size_t i = 0; i < args.size(); i++) {
    memcpy(p, args[i].c_str(), args[i].size() + 1);
    argv[i] = p;
    p += args[i].size() + 1;
  }

  RedirectOutput();
  return node::Start(static_cast<int>(args.size()), argv);
}
