#pragma once

// Bumped by hand. firmware/build.sh reads this string to name the output image
// (NexonOBD-v<version>.bin) and the dashboard shows it in the header, so the build
// on the bench and the build on the car can be told apart without guessing.
#define FW_VERSION "1.2.4"
