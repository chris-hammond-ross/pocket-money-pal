cmake_minimum_required(VERSION 3.22.1)
project(pmpnode CXX)

# libnode.so from fogtape/nodejs-mobile (ADR 0029), unpacked by scripts/fetch-node.mjs.
add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION ${NODE_DIR}/jniLibs/${ANDROID_ABI}/libnode.so)

add_library(pmpnode SHARED node_bridge.cpp)
target_compile_features(pmpnode PRIVATE cxx_std_17)
target_link_libraries(pmpnode node log)
# 16 KB pages (Android 15+ devices, and Play's requirement).
target_link_options(pmpnode PRIVATE "-Wl,-z,max-page-size=16384")
