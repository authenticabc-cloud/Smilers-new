cmake_minimum_required(VERSION 3.13)
project(appmodules)

# NDK 27 Windows fix: must be before any add_library/add_subdirectory calls.
# link_libraries() is directory-scoped and propagates to all subdirectory targets,
# including every react_codegen_XXX target added via Android-autolinking.cmake.
link_libraries(c++_shared)

include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)
