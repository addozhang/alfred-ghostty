NAME := alfred-ghostty
DIST := dist

.PHONY: build test clean

build: $(DIST)/$(NAME).alfredworkflow

$(DIST)/$(NAME).alfredworkflow: info.plist icon.png src/*.js
	@mkdir -p $(DIST)
	zip -r -j $@ info.plist icon.png >/dev/null
	zip -r $@ src >/dev/null
	@echo "built $@"

test:
	@test/run-tests.sh

clean:
	rm -rf $(DIST)
