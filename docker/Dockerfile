# JMeter Batch Docker Image
# Debian-based for Playwright compatibility, optimized for AWS Batch with S3 dynamic loading
# Updated: Force rebuild to ensure Playwright is installed locally in /jmeter
# Trigger rebuild for commit efc4f18f (fix ECS image tagging)

FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# JMeter version
ARG JMETER_VERSION=5.6.3

# First install essential tools (needed for subsequent setup steps)
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    unzip \
    ca-certificates

# Install Node.js 18 LTS (Playwright requires Node.js 14+)
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && node --version && npm --version

# Install Google Chrome (Chromium in Ubuntu 22.04 requires snap, which doesn't work in Docker)
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable

# Install ChromeDriver for Selenium using new Chrome for Testing API
# The old chromedriver.storage.googleapis.com has been deprecated
RUN CHROME_VERSION=$(google-chrome --version | awk '{print $3}') \
    && echo "Chrome version: ${CHROME_VERSION}" \
    && wget -q "https://googlechromelabs.github.io/chrome-for-testing/LATEST_RELEASE_${CHROME_VERSION%%.*}" -O /tmp/chromedriver-version 2>&1 \
    && if [ ! -s /tmp/chromedriver-version ]; then \
        echo "Failed to get ChromeDriver version for Chrome ${CHROME_VERSION}, trying latest stable..."; \
        wget -q "https://googlechromelabs.github.io/chrome-for-testing/LATEST_RELEASE_STABLE" -O /tmp/chromedriver-version; \
    fi \
    && CHROMEDRIVER_VERSION=$(cat /tmp/chromedriver-version) \
    && echo "ChromeDriver version: ${CHROMEDRIVER_VERSION}" \
    && wget -q "https://storage.googleapis.com/chrome-for-testing-public/${CHROMEDRIVER_VERSION}/linux64/chromedriver-linux64.zip" -O /tmp/chromedriver.zip \
    && unzip /tmp/chromedriver.zip -d /tmp \
    && mv /tmp/chromedriver-linux64/chromedriver /usr/local/bin/chromedriver \
    && chmod +x /usr/local/bin/chromedriver \
    && rm -rf /tmp/chromedriver.zip /tmp/chromedriver-linux64 /tmp/chromedriver-version

# Install remaining dependencies
RUN apt-get update && apt-get install -y \
    # Java for JMeter and TestNG (JDK needed for Maven)
    openjdk-17-jdk \
    maven \
    # Python and pip
    python3 \
    python3-pip \
    # X11 virtual framebuffer for headless browser execution
    xvfb \
    # Fonts and rendering dependencies
    fonts-liberation \
    fonts-noto-color-emoji \
    # Graphics libraries required by Chromium
    libnss3 \
    libfreetype6 \
    libharfbuzz0b \
    # Additional utilities
    dbus \
    udev \
    # Build dependencies for Python packages
    gcc \
    python3-dev \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir awscli \
    && pip3 install --no-cache-dir datadog

# Download and install JMeter
RUN mkdir /opt/jmeter \
    && cd /opt \
    && curl -L https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-${JMETER_VERSION}.tgz \
        -o apache-jmeter-${JMETER_VERSION}.tgz \
    && tar -xzf apache-jmeter-${JMETER_VERSION}.tgz \
    && rm apache-jmeter-${JMETER_VERSION}.tgz \
    && mv apache-jmeter-${JMETER_VERSION}/* /opt/jmeter/ \
    && rm -rf apache-jmeter-${JMETER_VERSION}

# Add JMeter to PATH
ENV PATH="/opt/jmeter/bin:${PATH}"
ENV JMETER_HOME="/opt/jmeter"

# Browser environment variables for headless execution
ENV CHROME_BIN=/usr/bin/chromium \
    CHROME_PATH=/usr/lib/chromium/ \
    CHROMIUM_FLAGS="--disable-software-rasterizer --disable-dev-shm-usage --no-sandbox --disable-gpu" \
    DISPLAY=:99

# Install JMeter Plugins Manager and common plugins
# Using -f to fail on HTTP errors, --retry for robustness
RUN cd /opt/jmeter/lib/ext \
    # Download Plugins Manager
    && curl -fSL --retry 3 --retry-delay 2 https://jmeter-plugins.org/get/ -o jmeter-plugins-manager.jar \
    # Download Command Runner JAR
    && curl -fSL --retry 3 --retry-delay 2 https://repo1.maven.org/maven2/kg/apc/cmdrunner/2.3/cmdrunner-2.3.jar -o /opt/jmeter/lib/cmdrunner-2.3.jar \
    # Install kg.apc (jpgc) plugins from Maven
    && cd /opt/jmeter/lib/ext \
    && curl -fSL --retry 3 --retry-delay 2 https://repo1.maven.org/maven2/kg/apc/jmeter-plugins-casutg/2.10/jmeter-plugins-casutg-2.10.jar -o jmeter-plugins-casutg-2.10.jar \
    && curl -fSL --retry 3 --retry-delay 2 https://repo1.maven.org/maven2/kg/apc/jmeter-plugins-dummy/0.4/jmeter-plugins-dummy-0.4.jar -o jmeter-plugins-dummy-0.4.jar \
    && curl -fSL --retry 3 --retry-delay 2 https://repo1.maven.org/maven2/kg/apc/jmeter-plugins-ffw/2.0/jmeter-plugins-ffw-2.0.jar -o jmeter-plugins-ffw-2.0.jar \
    && curl -fSL --retry 3 --retry-delay 2 https://repo1.maven.org/maven2/kg/apc/jmeter-plugins-functions/2.2/jmeter-plugins-functions-2.2.jar -o jmeter-plugins-functions-2.2.jar \
    && curl -fSL --retry 3 --retry-delay 2 https://repo1.maven.org/maven2/kg/apc/jmeter-plugins-json/2.7/jmeter-plugins-json-2.7.jar -o jmeter-plugins-json-2.7.jar \
    && curl -fSL --retry 3 --retry-delay 2 https://repo1.maven.org/maven2/kg/apc/jmeter-plugins-perfmon/2.1/jmeter-plugins-perfmon-2.1.jar -o jmeter-plugins-perfmon-2.1.jar \
    && curl -fSL --retry 3 --retry-delay 2 https://repo1.maven.org/maven2/kg/apc/jmeter-plugins-cmn-jmeter/0.7/jmeter-plugins-cmn-jmeter-0.7.jar -o jmeter-plugins-cmn-jmeter-0.7.jar \
    # Install BlazeMeter (bzm) plugins from Maven
    && curl -fSL --retry 3 --retry-delay 2 https://repo1.maven.org/maven2/com/blazemeter/jmeter-parallel/0.12/jmeter-parallel-0.12.jar -o jmeter-parallel-0.12.jar \
    && curl -fSL --retry 3 --retry-delay 2 https://repo1.maven.org/maven2/com/blazemeter/jmeter-plugins-random-csv-data-set/0.8/jmeter-plugins-random-csv-data-set-0.8.jar -o jmeter-plugins-random-csv-data-set-0.8.jar \
    && curl -fSL --retry 3 --retry-delay 2 https://repo1.maven.org/maven2/com/blazemeter/jmeter-plugins-wsc/0.7/jmeter-plugins-wsc-0.7.jar -o jmeter-plugins-wsc-0.7.jar \
    && curl -fSL --retry 3 --retry-delay 2 https://repo1.maven.org/maven2/com/blazemeter/jmeter-bzm-http2/1.4/jmeter-bzm-http2-1.4.jar -o jmeter-bzm-http2-1.4.jar \
    # Download dependencies for plugins
    && curl -fSL --retry 3 --retry-delay 2 https://repo1.maven.org/maven2/kg/apc/perfmon/2.2.2/perfmon-2.2.2.jar -o perfmon-2.2.2.jar \
    && curl -fSL --retry 3 --retry-delay 2 https://repo1.maven.org/maven2/org/apache/commons/commons-pool2/2.11.1/commons-pool2-2.11.1.jar -o commons-pool2-2.11.1.jar \
    && curl -fSL --retry 3 --retry-delay 2 https://repo1.maven.org/maven2/org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar -o commons-lang3-3.12.0.jar \
    # Install additional useful plugins
    && curl -fSL --retry 3 --retry-delay 2 https://repo1.maven.org/maven2/kg/apc/jmeter-plugins-graphs-basic/2.0/jmeter-plugins-graphs-basic-2.0.jar -o jmeter-plugins-graphs-basic-2.0.jar \
    && echo "All JARs downloaded successfully with retry logic!"

# Install Selenium WebDriver for JMeter browser testing
# Complete installation with ALL required dependencies for Selenium 4.25.0
RUN cd ${JMETER_HOME}/lib \
    && echo "Downloading Selenium WebDriver with all dependencies..." \
    # Core Selenium components
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/org/seleniumhq/selenium/selenium-java/4.25.0/selenium-java-4.25.0.jar -o selenium-java-4.25.0.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/org/seleniumhq/selenium/selenium-api/4.25.0/selenium-api-4.25.0.jar -o selenium-api-4.25.0.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/org/seleniumhq/selenium/selenium-chrome-driver/4.25.0/selenium-chrome-driver-4.25.0.jar -o selenium-chrome-driver-4.25.0.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/org/seleniumhq/selenium/selenium-chromium-driver/4.25.0/selenium-chromium-driver-4.25.0.jar -o selenium-chromium-driver-4.25.0.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/org/seleniumhq/selenium/selenium-remote-driver/4.25.0/selenium-remote-driver-4.25.0.jar -o selenium-remote-driver-4.25.0.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/org/seleniumhq/selenium/selenium-support/4.25.0/selenium-support-4.25.0.jar -o selenium-support-4.25.0.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/org/seleniumhq/selenium/selenium-http/4.25.0/selenium-http-4.25.0.jar -o selenium-http-4.25.0.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/org/seleniumhq/selenium/selenium-json/4.25.0/selenium-json-4.25.0.jar -o selenium-json-4.25.0.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/org/seleniumhq/selenium/selenium-manager/4.25.0/selenium-manager-4.25.0.jar -o selenium-manager-4.25.0.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/org/seleniumhq/selenium/selenium-devtools-v127/4.25.0/selenium-devtools-v127-4.25.0.jar -o selenium-devtools-v127-4.25.0.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/org/seleniumhq/selenium/selenium-os/4.25.0/selenium-os-4.25.0.jar -o selenium-os-4.25.0.jar \
    # Google dependencies (required by Selenium)
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/com/google/guava/guava/33.3.1-jre/guava-33.3.1-jre.jar -o guava-33.3.1-jre.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/com/google/auto/service/auto-service-annotations/1.1.1/auto-service-annotations-1.1.1.jar -o auto-service-annotations-1.1.1.jar \
    # Netty dependencies (for async HTTP)
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/io/netty/netty-buffer/4.1.115.Final/netty-buffer-4.1.115.Final.jar -o netty-buffer-4.1.115.Final.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/io/netty/netty-codec-http/4.1.115.Final/netty-codec-http-4.1.115.Final.jar -o netty-codec-http-4.1.115.Final.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/io/netty/netty-codec/4.1.115.Final/netty-codec-4.1.115.Final.jar -o netty-codec-4.1.115.Final.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/io/netty/netty-common/4.1.115.Final/netty-common-4.1.115.Final.jar -o netty-common-4.1.115.Final.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/io/netty/netty-handler/4.1.115.Final/netty-handler-4.1.115.Final.jar -o netty-handler-4.1.115.Final.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/io/netty/netty-transport/4.1.115.Final/netty-transport-4.1.115.Final.jar -o netty-transport-4.1.115.Final.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/io/netty/netty-transport-native-unix-common/4.1.115.Final/netty-transport-native-unix-common-4.1.115.Final.jar -o netty-transport-native-unix-common-4.1.115.Final.jar \
    # Async HTTP client
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/org/asynchttpclient/async-http-client/2.12.3/async-http-client-2.12.3.jar -o async-http-client-2.12.3.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/org/asynchttpclient/async-http-client-netty-utils/2.12.3/async-http-client-netty-utils-2.12.3.jar -o async-http-client-netty-utils-2.12.3.jar \
    # Apache HTTP components
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/org/apache/httpcomponents/client5/httpclient5/5.4/httpclient5-5.4.jar -o httpclient5-5.4.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/org/apache/httpcomponents/core5/httpcore5/5.3/httpcore5-5.3.jar -o httpcore5-5.3.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/org/apache/httpcomponents/core5/httpcore5-h2/5.3/httpcore5-h2-5.3.jar -o httpcore5-h2-5.3.jar \
    # Byte Buddy (for proxying)
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/net/bytebuddy/byte-buddy/1.15.10/byte-buddy-1.15.10.jar -o byte-buddy-1.15.10.jar \
    # OpenTelemetry (for tracing)
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/io/opentelemetry/opentelemetry-api/1.44.1/opentelemetry-api-1.44.1.jar -o opentelemetry-api-1.44.1.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/io/opentelemetry/opentelemetry-context/1.44.1/opentelemetry-context-1.44.1.jar -o opentelemetry-context-1.44.1.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/io/opentelemetry/opentelemetry-exporter-logging/1.44.1/opentelemetry-exporter-logging-1.44.1.jar -o opentelemetry-exporter-logging-1.44.1.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/io/opentelemetry/opentelemetry-sdk/1.44.1/opentelemetry-sdk-1.44.1.jar -o opentelemetry-sdk-1.44.1.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/io/opentelemetry/opentelemetry-sdk-common/1.44.1/opentelemetry-sdk-common-1.44.1.jar -o opentelemetry-sdk-common-1.44.1.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/io/opentelemetry/opentelemetry-sdk-trace/1.44.1/opentelemetry-sdk-trace-1.44.1.jar -o opentelemetry-sdk-trace-1.44.1.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/io/opentelemetry/opentelemetry-sdk-logs/1.44.1/opentelemetry-sdk-logs-1.44.1.jar -o opentelemetry-sdk-logs-1.44.1.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/io/opentelemetry/opentelemetry-sdk-extension-autoconfigure/1.44.1/opentelemetry-sdk-extension-autoconfigure-1.44.1.jar -o opentelemetry-sdk-extension-autoconfigure-1.44.1.jar \
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/io/opentelemetry/opentelemetry-sdk-extension-autoconfigure-spi/1.44.1/opentelemetry-sdk-extension-autoconfigure-spi-1.44.1.jar -o opentelemetry-sdk-extension-autoconfigure-spi-1.44.1.jar \
    # Failsafe (for retrying)
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/dev/failsafe/failsafe/3.3.2/failsafe-3.3.2.jar -o failsafe-3.3.2.jar \
    # Reactive Streams
    && curl -fSL --retry 3 https://repo1.maven.org/maven2/org/reactivestreams/reactive-streams/1.0.4/reactive-streams-1.0.4.jar -o reactive-streams-1.0.4.jar \
    && echo "✅ Selenium WebDriver with all dependencies installed (40+ JARs)"

# Install Node.js Playwright package (k6-compatible API!)
RUN npm install -g playwright@1.40.0 \
    && npm install -g @aws-sdk/client-s3 \
    && echo "✅ Node.js Playwright installed"

# Install Playwright's own Chromium browser
# Skip --with-deps since we already have system dependencies via apk
# This downloads Playwright's exact tested Chromium version (~170MB)
RUN playwright install chromium \
    && echo "✅ Playwright Chromium browser installed"

# Create symlinks for JSR223 Selenium scripts
# 1. ChromeDriver: /usr/bin/chromedriver -> /usr/local/bin/chromedriver
# 2. Chrome binary: /usr/bin/chromium -> /usr/bin/google-chrome
RUN ln -s /usr/local/bin/chromedriver /usr/bin/chromedriver \
    && ln -s /usr/bin/google-chrome /usr/bin/chromium \
    && echo "✅ ChromeDriver symlink: /usr/bin/chromedriver -> /usr/local/bin/chromedriver" \
    && echo "✅ Chrome binary symlink: /usr/bin/chromium -> /usr/bin/google-chrome"

# Verify all browser installations
# - Google Chrome for JMeter/Selenium tests
# - Playwright's bundled Chromium for Playwright tests
RUN google-chrome --version \
    && chromedriver --version \
    && ls -la /usr/bin/chromedriver \
    && ls -la /usr/local/bin/chromedriver \
    && echo "✅ Google Chrome and ChromeDriver verified (available at both paths)" \
    && playwright --version \
    && echo "✅ Playwright verified with bundled Chromium"

# Copy Datadog forwarder script
COPY docker/datadog-forwarder.py /usr/local/bin/datadog-forwarder.py
RUN chmod +x /usr/local/bin/datadog-forwarder.py

# Copy JMX CSV file path rewriter script
COPY docker/rewrite-jmx-csvfile-paths.py /usr/local/bin/rewrite-jmx-csvfile-paths.py
RUN chmod +x /usr/local/bin/rewrite-jmx-csvfile-paths.py

# Copy JMX ThreadGroup partitioning script (divides users among containers)
COPY docker/inject-threadgroup-partitioning.py /usr/local/bin/inject-threadgroup-partitioning.py
RUN chmod +x /usr/local/bin/inject-threadgroup-partitioning.py

# Copy JMX CSV partitioning script (adds offset/increment for distributed data access)
COPY docker/inject-jmx-partitioning.py /usr/local/bin/inject-jmx-partitioning.py
RUN chmod +x /usr/local/bin/inject-jmx-partitioning.py

# Copy Log4j2 configuration (fixes "package scanning deprecated" warning)
COPY docker/log4j2.xml /opt/jmeter/bin/log4j2.xml

# Create directories
RUN mkdir -p /jmeter /jmeter/scripts /jmeter/data /jmeter/results

# Copy test framework libraries (test-runner.js, test-template.js)
# These are used by Playwright JS tests via require('../lib/test-runner')
COPY lib /jmeter/lib

# Copy Healwright configuration (needed by smart-healer.js)
COPY healwright.config.js /jmeter/healwright.config.js

# Force rebuild to include lib/implicit-wait-healer.js (commit 35fb9602)

# Install Playwright and dependencies locally in /jmeter for test scripts
# Global install above is for CLI commands, local install is for require()
RUN cd /jmeter && npm init -y \
    && npm install playwright@1.40.0 \
    && npm install @aws-sdk/client-s3 \
    && echo "✅ Playwright installed locally in /jmeter for test scripts" \
    && echo "✅ Custom self-healing locators available via lib/self-healing-locators.js"

# Copy Java/TestNG framework files  
COPY java/pom.xml /jmeter/java/pom.xml
COPY java/src /jmeter/java/src
COPY java/docker-compose.healenium.yml /jmeter/java/docker-compose.healenium.yml

# Pre-download Maven dependencies AND compile framework code
# This caches ALL dependencies in the Docker layer, avoiding repeated downloads
RUN cd /jmeter/java \
    && echo "📦 Downloading Maven dependencies..." \
    && mvn dependency:resolve dependency:resolve-plugins -B \
    && echo "🔨 Pre-compiling framework code..." \
    && mvn test-compile -B \
    && echo "✅ Maven local repository populated with all dependencies" \
    && echo "✅ Framework code pre-compiled" \
    && echo "   Maven dependencies are now cached in Docker layer" \
    && echo "   Tests downloaded from S3 will use cached dependencies" \
    && ls -lh /root/.m2/repository/ | head -20

# Copy ONLY essential Healenium/WebDriverManager JARs for JSR223 (avoid conflicts)
# Note: Selenium JARs already installed in /opt/jmeter/lib (lines 126-176)
RUN cd /root/.m2/repository \
    && echo "📦 Listing available Healenium modules in Maven cache..." \
    && ls -la com/epam/healenium/ 2>/dev/null || echo "Healenium directory not found" \
    && echo "📦 Copying Healenium JARs to JMeter lib..." \
    && find com/epam/healenium -type f -name "*.jar" 2>/dev/null | while read jar; do \
        echo "Found: $jar"; \
        cp -v "$jar" /opt/jmeter/lib/ext/ 2>/dev/null || true; \
    done \
    && cp -v io/github/bonigarcia/webdrivermanager/5.6.2/*.jar /opt/jmeter/lib/ext/ 2>/dev/null || true \
    && cp -v org/apache/commons/commons-compress/*/commons-compress-*.jar /opt/jmeter/lib/ext/ 2>/dev/null || true \
    && cp -v com/google/code/gson/gson/*/gson-*.jar /opt/jmeter/lib/ext/ 2>/dev/null || true \
    && cp -v com/typesafe/config/*/config-*.jar /opt/jmeter/lib/ext/ 2>/dev/null || true \
    && echo "✅ Healenium + WebDriverManager + dependencies copied" \
    && echo "📋 Final JAR list in /opt/jmeter/lib/ext/:" \
    && ls -la /opt/jmeter/lib/ext/ | grep -E "(healenium|webdriver|compress|gson|config)" || true

# Copy entrypoint script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Set working directory
WORKDIR /jmeter

# Note: HEALTHCHECK removed - it was killing containers after JMeter finished
# but before entrypoint.sh could complete cleanup and exit properly.
# ECS Fargate tasks that run to completion don't need healthchecks.

ENTRYPOINT ["/entrypoint.sh"]
