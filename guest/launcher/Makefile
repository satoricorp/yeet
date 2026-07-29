# Build the yeet microVM launcher. Same C file on both platforms — libkrun's API is
# identical over Hypervisor.framework (macOS) and KVM (Linux); the differences are all in
# how the binary is blessed and linked.
#
# macOS: the codesign step is not optional. Calling Hypervisor.framework requires
# com.apple.security.hypervisor, and an unsigned binary fails at krun_start_enter. There is
# also no -rpath: libkrun dlopen()s libkrunfw by leaf name at runtime, so rpath cannot reach
# it; the *caller* must set DYLD_LIBRARY_PATH=$(PREFIX)/lib. See the header in yeet-vm.c.
#
# Linux: no signing, no env override — the same dlopen is resolved by ldconfig. Needs
# /dev/kvm at runtime (a nested-virt cloud VM or bare metal) and libkrun/libkrunfw installed
# (dnf install libkrun on Fedora; built from source elsewhere).
UNAME := $(shell uname -s)

ifeq ($(UNAME),Darwin)
PREFIX  := $(shell brew --prefix)
CFLAGS  := -O2 -g -Wall -Wextra -I$(PREFIX)/include
LDFLAGS := -L$(PREFIX)/lib -lkrun

yeet-vm: yeet-vm.c yeet-vm.entitlements
	cc -o $@ $< $(CFLAGS) $(LDFLAGS)
	codesign --entitlements yeet-vm.entitlements --force -s - $@
else
CFLAGS  := -O2 -g -Wall -Wextra
LDFLAGS := -lkrun

yeet-vm: yeet-vm.c
	cc -o $@ $< $(CFLAGS) $(LDFLAGS)
endif

.PHONY: clean
clean:
	rm -rf yeet-vm yeet-vm.dSYM
