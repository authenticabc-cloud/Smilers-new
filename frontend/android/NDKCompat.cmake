# NDKCompat.cmake — NDK 27 on Windows: c++_shared must be linked explicitly.
# Injected via CMAKE_PROJECT_INCLUDE in the top-level build.gradle hook.
if(ANDROID)
    link_libraries(c++_shared)
    string(APPEND CMAKE_SHARED_LINKER_FLAGS " -Wl,--allow-shlib-undefined")
endif()
