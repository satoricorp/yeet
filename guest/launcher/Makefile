# Build the yeet microVM launcher and codesign it with the hypervisor entitlement.
#
# The codesign step is not optional: calling Hypervisor.framework requires
# com.apple.security.hypervisor, and an unsigned binary fails at krun_start_enter.
#
# Note there is no -rpath here. libkrun dlopen()s libkrunfw by leaf name at runtime, so
# rpath cannot reach it; the *caller* must set DYLD_LIBRARY_PATH=$(PREFIX)/lib. See the
# header comment in yeet-vm.c.
PREFIX  := $(shell brew --prefix)
CFLAGS  := -O2 -g -Wall -Wextra -I$(PREFIX)/include
LDFLAGS := -L$(PREFIX)/lib -lkrun

yeet-vm: yeet-vm.c yeet-vm.entitlements
	cc -o $@ $< $(CFLAGS) $(LDFLAGS)
	codesign --entitlements yeet-vm.entitlements --force -s - $@

.PHONY: clean
clean:
	rm -rf yeet-vm yeet-vm.dSYM
