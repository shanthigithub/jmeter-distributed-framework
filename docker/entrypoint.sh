#!/bin/bash
set -e  # Exit on error (removed -x diagnostic logging)

echo "=========================================="
echo "JMeter Batch Framework Container"
echo "=========================================="
echo "Test ID: ${TEST_ID:-unknown}"
echo "Container ID: ${CONTAINER_ID:-unknown}"
echo "Run ID: ${RUN_ID:-unknown}"
echo "=========================================="

# Environment variables
CONFIG_BUCKET="${CONFIG_BUCKET:-}"
RESULTS_BUCKET="${RESULTS_BUCKET:-}"
RESULTS_PREFIX="${RESULTS_PREFIX:-results}"

# Calculate JVM memory dynamically (80% of container memory)
if [ -z "$JVM_ARGS" ]; then
    # Get total memory in MB from cgroup (works in Docker/ECS)
    if [ -f /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
        TOTAL_MEMORY_BYTES=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)
    elif [ -f /sys/fs/cgroup/memory.max ]; then
        # cgroup v2
        TOTAL_MEMORY_BYTES=$(cat /sys/fs/cgroup/memory.max)
    else
        # Fallback to system memory
        TOTAL_MEMORY_BYTES=$(free -b | awk '/^Mem:/ {print $2}')
    fi
    
    # Convert to MB
    TOTAL_MEMORY_MB=$((TOTAL_MEMORY_BYTES / 1024 / 1024))
    
    # Calculate 80% for max heap, 50% for initial heap
    MAX_HEAP_MB=$((TOTAL_MEMORY_MB * 80 / 100))
    INIT_HEAP_MB=$((TOTAL_MEMORY_MB * 50 / 100))
    
    # Ensure minimum viable heap sizes
    if [ $MAX_HEAP_MB -lt 512 ]; then
        MAX_HEAP_MB=512
        INIT_HEAP_MB=256
    fi
    
    JVM_ARGS="-Xms${INIT_HEAP_MB}m -Xmx${MAX_HEAP_MB}m"
    echo "[JVM] Auto-calculated memory: Container=${TOTAL_MEMORY_MB}MB, JVM Max=${MAX_HEAP_MB}MB (80%), Init=${INIT_HEAP_MB}MB (50%)"
else
    echo "[JVM] Using custom JVM_ARGS: ${JVM_ARGS}"
fi

# Validate environment
if [ -z "$CONFIG_BUCKET" ] || [ -z "$RESULTS_BUCKET" ] || [ -z "$TEST_SCRIPT_S3" ]; then
    echo " [ERROR] Required environment variables not set:"
    echo "   CONFIG_BUCKET=${CONFIG_BUCKET:-<not set>}"
    echo "   RESULTS_BUCKET=${RESULTS_BUCKET:-<not set>}"
    echo "   TEST_SCRIPT_S3=${TEST_SCRIPT_S3:-<not set>}"
    exit 1
fi

echo "[CONFIG] Config Bucket: s3://${CONFIG_BUCKET}"
echo "[CONFIG] Results Bucket: s3://${RESULTS_BUCKET}"
echo "[CONFIG] Test Script: ${TEST_SCRIPT_S3}"
if [ -n "$DATA_FILE_S3" ]; then
    echo "[CONFIG] Data File: ${DATA_FILE_S3}"
fi
echo "[CONFIG] JVM Args: ${JVM_ARGS}"
echo ""

# Function to download S3 file with validation
download_s3_file() {
    local s3_path=$1
    local local_path=$2
    
    # Parse s3://bucket/key format
    if [[ $s3_path =~ ^s3://([^/]+)/(.+)$ ]]; then
        local bucket="${BASH_REMATCH[1]}"
        local key="${BASH_REMATCH[2]}"
        
        echo "  [VALIDATE] Checking if file exists: s3://${bucket}/${key}"
        
        # Check if file exists in S3 before attempting download
        if aws s3 ls "s3://${bucket}/${key}" >/dev/null 2>&1; then
            echo "   [VALIDATED] File exists in S3"
        else
            echo "   [ERROR] File NOT found in S3: s3://${bucket}/${key}"
            echo ""
            echo "  [DIAGNOSTIC HINTS]"
            echo "  1. Verify file exists:"
            echo "     aws s3 ls s3://${bucket}/${key}"
            echo ""
            echo "  2. List all files in directory:"
            echo "     aws s3 ls s3://${bucket}/$(dirname ${key})/"
            echo ""
            echo "  3. Check bucket name: ${bucket}"
            echo "  4. Check key path: ${key}"
            echo ""
            return 1
        fi
        
        # Check if we have permission to read from this bucket
        echo "  [VALIDATE] Checking S3 read permissions..."
        if aws s3api head-object --bucket "${bucket}" --key "${key}" >/dev/null 2>&1; then
            echo "   [VALIDATED] S3 read permissions OK"
        else
            echo "   [ERROR] Permission denied for s3://${bucket}/${key}"
            echo ""
            echo "  [REQUIRED IAM PERMISSIONS]"
            echo "  The ECS Task Role needs these permissions:"
            echo "  {"
            echo "    \"Effect\": \"Allow\","
            echo "    \"Action\": ["
            echo "      \"s3:GetObject\","
            echo "      \"s3:ListBucket\""
            echo "    ],"
            echo "    \"Resource\": ["
            echo "      \"arn:aws:s3:::${bucket}\","
            echo "      \"arn:aws:s3:::${bucket}/*\""
            echo "    ]"
            echo "  }"
            echo ""
            echo "  [DEBUGGING STEPS]"
            echo "  1. Check task role ARN in ECS task definition"
            echo "  2. Verify IAM policies attached to that role"
            echo "  3. Test manually: aws s3 cp s3://${bucket}/${key} /tmp/test"
            echo ""
            return 1
        fi
        
        # Now download the file
        echo "  [DOWNLOAD] s3://${bucket}/${key}  ${local_path}"
        echo "  [AWS CLI] Running: aws s3 cp s3://${bucket}/${key} ${local_path}"
        
        # Run download and capture output
        download_output=$(aws s3 cp "s3://${bucket}/${key}" "${local_path}" 2>&1)
        download_exit=$?
        
        # Show AWS CLI output if any
        if [ -n "$download_output" ]; then
            echo "  [AWS CLI OUTPUT] $download_output"
        fi
        
        if [ $download_exit -eq 0 ]; then
            # Verify download succeeded
            if [ -f "${local_path}" ]; then
                local file_size=$(stat -c%s "${local_path}" 2>/dev/null || stat -f%z "${local_path}" 2>/dev/null || echo "0")
                echo "   [SUCCESS] Downloaded ${file_size} bytes to: ${local_path}"
                ls -lh "${local_path}" | awk '{print "  [FILE INFO] " $0}'
                
                # Additional validation for CSV files
                if [[ "${local_path}" == *.csv ]]; then
                    echo "  [VALIDATE] Checking CSV file integrity..."
                    
                    # Check if file is empty
                    if [ "$file_size" -eq 0 ]; then
                        echo "   [ERROR] CSV file is empty (0 bytes)"
                        return 1
                    fi
                    
                    # Check if file has at least one line (header)
                    line_count=$(wc -l < "${local_path}" 2>/dev/null || echo "0")
                    if [ "$line_count" -eq 0 ]; then
                        echo "   [ERROR] CSV file has no lines"
                        echo "  [DEBUG] First 100 bytes of file:"
                        head -c 100 "${local_path}" | od -c
                        return 1
                    fi
                    
                    # Show first line (header) for debugging
                    echo "  [CSV HEADER] $(head -n 1 "${local_path}")"
                    echo "  [CSV INFO] File has ${line_count} lines"
                    
                    # Print full CSV content for debugging (first 20 lines)
                    echo "  [CSV CONTENT] First 20 lines of CSV file:"
                    echo "  ----------------------------------------"
                    head -n 20 "${local_path}" | while IFS= read -r line; do
                        echo "  | $line"
                    done
                    echo "  ----------------------------------------"
                    
                    # Also show hex dump of first line to detect encoding issues
                    echo "  [CSV HEX] First line in hexadecimal (to detect hidden characters):"
                    head -n 1 "${local_path}" | od -A n -t x1 | head -2
                    
                    # Check for UTF-8 BOM and remove if present
                    if [ -f "${local_path}" ]; then
                        # Check for BOM (EF BB BF in hex)
                        bom_check=$(head -c 3 "${local_path}" | od -A n -t x1 | tr -d ' ')
                        if [ "$bom_check" = "efbbbf" ]; then
                            echo "    [WARNING] UTF-8 BOM detected - removing it"
                            # Remove BOM by skipping first 3 bytes
                            tail -c +4 "${local_path}" > "${local_path}.tmp"
                            mv "${local_path}.tmp" "${local_path}"
                            echo "   [FIXED] BOM removed from CSV file"
                        fi
                    fi
                fi
                
                return 0
            else
                echo "   [ERROR] Download exit code 0 but file not found: ${local_path}"
                echo "  [DEBUG] Listing directory:"
                ls -la "$(dirname ${local_path})" 2>&1 | head -20
                return 1
            fi
        else
            echo "   [ERROR] AWS CLI failed with exit code: $download_exit"
            echo "  [ERROR] Failed to download: s3://${bucket}/${key}"
            echo "  [HINT] Check task role IAM permissions and S3 bucket policy"
            return 1
        fi
    else
        echo "   [ERROR] Invalid S3 path format: ${s3_path}"
        echo "  [HINT] Expected format: s3://bucket-name/path/to/file"
        return 1
    fi
}

# Function to upload results to S3
upload_results() {
    local local_file=$1
    local s3_key=$2
    
    if [ -f "${local_file}" ]; then
        echo "  [UPLOAD] ${local_file}"
        if aws s3 cp "${local_file}" "s3://${RESULTS_BUCKET}/${s3_key}"; then
            echo "   [SUCCESS] Uploaded to: s3://${RESULTS_BUCKET}/${s3_key}"
            return 0
        else
            echo "    [WARNING] Failed to upload: ${local_file}"
            return 1
        fi
    else
        echo "    [WARNING] File not found: ${local_file}"
        return 1
    fi
}

# Download test files from S3 (using environment variables)
echo "=========================================="
echo "[DOWNLOAD] Downloading test files from S3"
echo "=========================================="
echo ""

# Download test script (required)
echo " Downloading test script..."

# Detect file extension from TEST_SCRIPT_S3
FILE_EXTENSION="${TEST_SCRIPT_S3##*.}"
echo " Detected file extension: .${FILE_EXTENSION}"

# Download to appropriate location based on extension
if [ "$FILE_EXTENSION" = "jmx" ]; then
    TEST_FILE="/tmp/test.jmx"
elif [ "$FILE_EXTENSION" = "py" ]; then
    TEST_FILE="/tmp/test.py"
elif [ "$FILE_EXTENSION" = "js" ]; then
    TEST_FILE="/tmp/test.js"
else
    echo " [ERROR] Unsupported file extension: .${FILE_EXTENSION}"
    echo "   Supported extensions:"
    echo "   - .jmx  (JMeter - API tests, JSR223 browser tests with Healenium)"
    echo "   - .py   (Python Playwright - browser tests)"
    echo "   - .js   (JavaScript Playwright - k6-ready browser tests with Healwright)"
    exit 1
fi

echo " Test file will be saved to: ${TEST_FILE}"

if ! download_s3_file "$TEST_SCRIPT_S3" "$TEST_FILE"; then
    echo ""
    echo " [FATAL] Failed to download test script"
    echo "Cannot proceed without test plan. Exiting..."
    exit 1
fi
echo ""

# Download data file (optional)
if [ -n "$DATA_FILE_S3" ]; then
    echo " Downloading data file..."
    # Extract filename from S3 path - PRESERVE ORIGINAL FILENAME (including spaces)
    # rewrite-jmx-csvfile-paths.py will match this exact filename
    DATA_FILENAME=$(basename "$DATA_FILE_S3")
    echo "  [INFO] S3 path: ${DATA_FILE_S3}"
    echo "  [INFO] Local filename: ${DATA_FILENAME} (preserves original name with spaces)"
    
    if ! download_s3_file "$DATA_FILE_S3" "/tmp/${DATA_FILENAME}"; then
        echo ""
        echo "  [WARNING] Failed to download data file, but continuing..."
    else
        echo "   Downloaded to: /tmp/${DATA_FILENAME}"
    fi
    echo ""
fi

# Rewrite JMX CSV paths to container paths (for JMX files only)
if [ "$FILE_EXTENSION" = "jmx" ] && [ -f "$TEST_FILE" ]; then
    echo "=========================================="
    echo "[JMX] Rewriting CSV file paths for container"
    echo "=========================================="
    echo "  Converting local CSV paths to container paths (/tmp/)"
    echo ""
    
    # List all CSV files in /tmp before rewriting
    echo "[JMX] CSV files in /tmp before JMX rewrite:"
    ls -lh /tmp/*.csv 2>/dev/null || echo "  (no CSV files found)"
    echo ""
    
    if python3 /usr/local/bin/rewrite-jmx-csvfile-paths.py "$TEST_FILE"; then
        echo "   JMX file updated with container paths"
    else
        echo "    Warning: Could not rewrite JMX CSV paths (will try to proceed)"
    fi
    
    # Inject ThreadGroup partitioning (divide users among containers)
    echo "=========================================="
    echo "[JMX] Injecting ThreadGroup Partitioning"
    echo "=========================================="
    echo "  Dividing thread count among containers"
    echo "  Container ${CONTAINER_ID:-0} of ${NUM_CONTAINERS:-1}"
    echo ""
    
    if python3 /usr/local/bin/inject-threadgroup-partitioning.py "$TEST_FILE" "${CONTAINER_ID:-0}" "${NUM_CONTAINERS:-1}"; then
        echo "   ThreadGroup partitioning injected successfully"
    else
        echo "    Warning: Could not inject ThreadGroup partitioning (all containers will run all threads!)"
    fi
    echo ""
    
    # Inject CSV partitioning (offset/increment for distributed execution)
    echo "=========================================="
    echo "[JMX] Injecting CSV Data Partitioning"
    echo "=========================================="
    echo "  Adding offset/increment for distributed data access"
    echo ""
    
    if python3 /usr/local/bin/inject-jmx-partitioning.py "$TEST_FILE" "${CONTAINER_ID:-0}" "${NUM_CONTAINERS:-1}"; then
        echo "   CSV partitioning injected successfully"
    else
        echo "    Warning: Could not inject CSV partitioning (will use sequential access)"
    fi
    
    # Show what the JMX file now references
    echo ""
    echo "[JMX] CSV references in JMX file after all modifications:"
    grep -A 1 'name="filename"' "$TEST_FILE" | grep -v "^--$" || echo "  (no CSV references found)"
    echo ""
    
    # 
    # ENHANCED DEBUG: Verify CSV files actually exist before JMeter runs
    # 
    echo "=========================================="
    echo "[DEBUG] CSV File Verification"
    echo "=========================================="
    echo ""
    
    # Extract CSV filenames from JMX
    echo "[DEBUG] 1. CSV files referenced in JMX:"
    CSV_FILES=$(grep -A 1 'name="filename"' "$TEST_FILE" | grep '<stringProp' | sed 's/.*<stringProp[^>]*>//; s/<\/stringProp>.*//')
    if [ -n "$CSV_FILES" ]; then
        echo "$CSV_FILES" | while read -r csv_path; do
            echo "   JMX references: ${csv_path}"
        done
    else
        echo "    No CSV files found in JMX"
    fi
    echo ""
    
    # List ALL files in /tmp
    echo "[DEBUG] 2. All files in /tmp directory:"
    ls -lah /tmp/ 2>/dev/null || echo "  (cannot list /tmp)"
    echo ""
    
    # Check each CSV file exists and is readable
    echo "[DEBUG] 3. CSV file existence check:"
    if [ -n "$CSV_FILES" ]; then
        echo "$CSV_FILES" | while read -r csv_path; do
            if [ -f "$csv_path" ]; then
                file_size=$(stat -c%s "$csv_path" 2>/dev/null || echo "unknown")
                echo "   EXISTS: ${csv_path} (${file_size} bytes)"
                
                # Show first 3 lines
                echo "     First 3 lines:"
                head -n 3 "$csv_path" | while read -r line; do
                    echo "       ${line}"
                done
            else
                echo "   MISSING: ${csv_path}"
                
                # Try to find similar files
                filename=$(basename "$csv_path")
                echo "     Looking for similar files with name: ${filename}"
                find /tmp -name "*${filename}*" 2>/dev/null | while read -r found; do
                    echo "       Found: ${found}"
                done
            fi
            echo ""
        done
    fi
    echo "=========================================="
    echo ""
fi

echo " [SUCCESS] All required downloads complete"
echo ""

# 
# NOTE: Datadog metrics are configured later via datadog-forwarder.py
# 

# Container Synchronization (optional)
# If ENABLE_SYNC=true, wait for START signal from coordinator before running test
if [ "${ENABLE_SYNC:-false}" = "true" ]; then
    echo "=========================================="
    echo "[SYNC] Waiting for START signal"
    echo "=========================================="
    echo "[SYNC] Container is READY"
    echo "[SYNC] Waiting for coordinator to signal all containers..."
    echo ""
    
    SIGNAL_KEY="signals/${RUN_ID}/START"
    MAX_SYNC_WAIT="${MAX_SYNC_WAIT:-600}"  # 10 minutes default
    SYNC_POLL_INTERVAL="${SYNC_POLL_INTERVAL:-3}"  # 3 seconds default
    
    sync_start_time=$(date +%s)
    sync_attempt=0
    
    while true; do
        sync_attempt=$((sync_attempt + 1))
        sync_elapsed=$(($(date +%s) - sync_start_time))
        
        # Check timeout
        if [ $sync_elapsed -gt $MAX_SYNC_WAIT ]; then
            echo " [ERROR] Timeout waiting for START signal after ${sync_elapsed}s"
            echo "[ERROR] Expected signal at: s3://${CONFIG_BUCKET}/${SIGNAL_KEY}"
            exit 1
        fi
        
        # Check if START signal exists in S3
        if aws s3 ls "s3://${CONFIG_BUCKET}/${SIGNAL_KEY}" >/dev/null 2>&1; then
            echo " [SYNC] START signal received!"
            
            # Download and display signal data
            signal_data=$(aws s3 cp "s3://${CONFIG_BUCKET}/${SIGNAL_KEY}" - 2>/dev/null)
            if [ -n "$signal_data" ]; then
                echo "[SYNC] Signal details:"
                echo "$signal_data" | grep -E '"(timestamp|taskCount|message)"' || echo "$signal_data"
            fi
            
            echo "[SYNC] All containers synchronized - proceeding with test"
            
            # Delete signal immediately - no longer needed after reading
            echo "[SYNC] Cleaning up temporary signal file..."
            if aws s3 rm "s3://${CONFIG_BUCKET}/${SIGNAL_KEY}" 2>/dev/null; then
                echo "   Deleted: s3://${CONFIG_BUCKET}/${SIGNAL_KEY}"
            else
                echo "    Could not delete signal (may not have permissions)"
            fi
            echo ""
            break
        fi
        
        # Log progress every 10 attempts
        if [ $((sync_attempt % 10)) -eq 0 ]; then
            echo "[SYNC] Still waiting... (${sync_elapsed}s elapsed, attempt ${sync_attempt})"
        fi
        
        # Wait before next check
        sleep $SYNC_POLL_INTERVAL
    done
else
    echo "[SYNC] Synchronization disabled - starting immediately"
    echo ""
fi

# Set JVM options
export JVM_ARGS

# Start Xvfb (X Virtual Framebuffer) for headless browser support
echo "=========================================="
echo "[BROWSER] Starting virtual display (Xvfb)"
echo "=========================================="
# Start Xvfb on display :99 in background
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -nolisten unix &
XVFB_PID=$!
echo "[BROWSER] Xvfb started (PID: ${XVFB_PID}, DISPLAY: :99)"
echo "[BROWSER] Virtual screen: 1920x1080x24"

# Wait for Xvfb to be ready
sleep 2

# Verify Xvfb is running
if kill -0 $XVFB_PID 2>/dev/null; then
    echo " [BROWSER] Virtual display ready for headless browser execution"
else
    echo "  [WARNING] Xvfb may have failed to start"
    echo "  [WARNING] Browser tests may not work properly"
fi
echo ""

# Route to appropriate test runner based on file extension
echo "=========================================="
if [ "$FILE_EXTENSION" = "jmx" ]; then
    echo "[RUN] JMeter Test Runner Selected"
    echo "=========================================="
    
    # Verify JMeter binary exists
    if command -v jmeter >/dev/null 2>&1; then
        echo "[INFO] JMeter binary: $(which jmeter)"
        jmeter --version 2>&1 | head -3 || echo "  (version check failed)"
    else
        echo " [ERROR] JMeter binary not found in PATH!"
        echo "[DEBUG] PATH=$PATH"
        exit 1
    fi
    echo ""
    
elif [ "$FILE_EXTENSION" = "py" ]; then
    echo "[RUN] Python Playwright Test Runner Selected"
    echo "=========================================="
    
    # Verify Python and Playwright exist
    if command -v python3 >/dev/null 2>&1; then
        echo "[INFO] Python: $(which python3)"
        python3 --version
        echo "[INFO] Playwright: $(python3 -c 'import playwright; print(playwright.__version__)')"
    else
        echo " [ERROR] Python3 not found!"
        echo "[DEBUG] PATH=$PATH"
        exit 1
    fi
    echo ""
    
elif [ "$FILE_EXTENSION" = "js" ]; then
    echo "[RUN] JavaScript Playwright Test Runner Selected (k6-ready!)"
    echo "=========================================="
    
    # Verify Node.js and Playwright exist
    if command -v node >/dev/null 2>&1; then
        echo "[INFO] Node.js: $(which node)"
        node --version
        echo "[INFO] npm: $(npm --version)"
        echo "[INFO] Playwright: $(node -e "console.log(require('playwright').version)")"
    else
        echo " [ERROR] Node.js not found!"
        echo "[DEBUG] PATH=$PATH"
        exit 1
    fi
    
    # Copy lib/ directory contents to root /lib so ../lib/test-runner resolves correctly
    # From /tmp/test.js, ../lib/test-runner resolves to /lib/test-runner
    # IMPORTANT: Use /jmeter/lib/* to copy CONTENTS, not the directory itself
    echo "[SETUP] Copying test framework libraries to /lib..."
    if [ -d "/jmeter/lib" ]; then
        echo "  [DEBUG] Contents of /jmeter/lib BEFORE copy:"
        ls -la /jmeter/lib || echo "  [ERROR] Failed to list /jmeter/lib"
        
        # Create /lib if it doesn't exist, then copy contents
        mkdir -p /lib
        cp -r /jmeter/lib/* /lib/
        echo "   Copied /jmeter/lib/*  /lib/"
        
        echo "  [DEBUG] Contents of /lib AFTER copy:"
        ls -la /lib || echo "  [ERROR] Failed to list /lib"
        
        echo "  [DEBUG] Checking if test-runner.js exists:"
        if [ -f "/lib/test-runner.js" ]; then
            echo "   Found: /lib/test-runner.js"
        else
            echo "   NOT FOUND: /lib/test-runner.js"
        fi
        
    echo "    Path resolution: /tmp/test.js -> require('../lib/test-runner') -> /lib/test-runner"
    else
        echo "    Warning: /jmeter/lib not found"
    fi
    echo ""
fi

# Start Datadog forwarder in background (if enabled)
FORWARDER_PID=""

echo " [DEBUG-ENTRYPOINT] Checking Datadog environment variable..."
echo " [DEBUG-ENTRYPOINT] ENABLE_DATADOG_METRICS='${ENABLE_DATADOG_METRICS:-NOT_SET}'"
echo " [DEBUG-ENTRYPOINT] Expected value: 'true' (lowercase)"

if [ "${ENABLE_DATADOG_METRICS:-false}" = "true" ]; then
    echo ""
    echo "=========================================="
    echo "[DATADOG]  Metrics ENABLED - Starting Forwarder"
    echo "=========================================="
    
    # Validate DD_API_KEY is provided
    if [ -z "$DD_API_KEY" ]; then
        echo "  [WARNING] ENABLE_DATADOG_METRICS=true but DD_API_KEY not set"
        echo "  [WARNING] Datadog metrics will NOT be sent"
        echo "  [HINT] Set DD_API_KEY in ECS task definition secrets"
    else
        # Set Datadog site (default from secrets manager or fallback)
        DD_SITE="${DD_SITE:-datadoghq.com}"
        
        # Build tags
        DD_TAGS="test_id:${TEST_ID},run_id:${RUN_ID},container_id:${CONTAINER_ID}"
        
        # Results file path
        RESULTS_JTL="/tmp/results-0.jtl"
        
        echo "[DATADOG] Configuration:"
        echo "  API Site: ${DD_SITE}"
        echo "  Tags: ${DD_TAGS}"
        echo "  JTL File: ${RESULTS_JTL}"
        
        # Start forwarder in background (isolated from set -e)
        (
            python3 /usr/local/bin/datadog-forwarder.py \
                --jtl-file "${RESULTS_JTL}" \
                --dd-api-key "${DD_API_KEY}" \
                --dd-site "${DD_SITE}" \
                --tags "${DD_TAGS}" \
                || true
        ) &
        FORWARDER_PID=$!
        
        echo " [DATADOG] Forwarder started (PID: ${FORWARDER_PID})"
        echo "[DATADOG] Metrics will be sent in real-time as test runs"
    fi
    echo ""
else
    echo "[DATADOG]   Metrics DISABLED"
    echo " [DEBUG-ENTRYPOINT] ENABLE_DATADOG_METRICS was set to: '${ENABLE_DATADOG_METRICS:-NOT_SET}'"
    echo " [DEBUG-ENTRYPOINT] This does NOT match 'true' (case-sensitive comparison)"
    echo ""
fi

# Calculate timeout: estimated duration + test buffer + UPLOAD buffer
ESTIMATED_DURATION=${ESTIMATED_DURATION_SECONDS:-3600}  # Default 1 hour if not set
TEST_TIMEOUT_BUFFER=$((30 * 60))  # 30 minutes buffer for test execution
UPLOAD_BUFFER=$((10 * 60))  # 10 minutes buffer for uploads (CRITICAL - prevents early container kill)
TEST_TIMEOUT=$((ESTIMATED_DURATION + TEST_TIMEOUT_BUFFER))  # Timeout for test execution only
TASK_TIMEOUT=$((ESTIMATED_DURATION + TEST_TIMEOUT_BUFFER + UPLOAD_BUFFER))  # Total task runtime

echo "=========================================="
echo "[TIMEOUT] Protection Settings"
echo "=========================================="
echo "Estimated Test Duration: ${ESTIMATED_DURATION}s ($(($ESTIMATED_DURATION / 60))m)"
echo "Test Timeout Buffer: ${TEST_TIMEOUT_BUFFER}s ($(($TEST_TIMEOUT_BUFFER / 60))m)"
echo "Upload Buffer: ${UPLOAD_BUFFER}s ($(($UPLOAD_BUFFER / 60))m) - ENSURES uploads complete"
echo "Test Maximum Runtime: ${TEST_TIMEOUT}s ($(($TEST_TIMEOUT / 60))m)"
echo "Task Maximum Runtime: ${TASK_TIMEOUT}s ($(($TASK_TIMEOUT / 60))m) - TOTAL allowed"
echo ""

# Execute test with timeout protection (route based on file extension)
echo "=========================================="
if [ "$FILE_EXTENSION" = "jmx" ]; then
    echo "[RUN] Running JMeter Test (with timeout protection)"
    echo "=========================================="
    echo "[COMMAND] timeout ${TEST_TIMEOUT} $@"
    echo ""
    
    # BusyBox timeout syntax: timeout SECONDS COMMAND (no -t flag needed)
    # Exit codes: 0 = success, 124 = timeout, others = JMeter error
    # NOTE: Using TEST_TIMEOUT (not TASK_TIMEOUT) to leave time for uploads after test
    timeout ${TEST_TIMEOUT} "$@" 2>&1
    JMETER_RAW_EXIT=$?
    
elif [ "$FILE_EXTENSION" = "py" ]; then
    echo "[RUN] Running Playwright Test (with timeout protection)"
    echo "=========================================="
    echo "[COMMAND] timeout ${TEST_TIMEOUT} python3 ${TEST_FILE}"
    echo ""
    echo "  [INFO] JMeter JVM will NOT start (Playwright runs directly)"
    echo "  [INFO] Memory saved: ~512 MB (no JMeter overhead)"
    echo ""
    
    # Export environment variables for Python script
    export CONFIG_BUCKET
    export RESULTS_BUCKET
    export TEST_ID
    export RUN_ID
    export CONTAINER_ID
    export RESULTS_PREFIX
    
    # Run Python script with timeout (using TEST_TIMEOUT to leave time for uploads)
    timeout ${TEST_TIMEOUT} python3 "${TEST_FILE}" 2>&1
    JMETER_RAW_EXIT=$?
    
elif [ "$FILE_EXTENSION" = "js" ]; then
    echo "[RUN] Running JavaScript Playwright Test (with timeout protection)"
    echo "=========================================="
    echo "[COMMAND] timeout ${TEST_TIMEOUT} node ${TEST_FILE}"
    echo ""
    echo "  [INFO] JMeter JVM will NOT start (Playwright runs directly)"
    echo "  [INFO] Memory saved: ~512 MB (no JMeter overhead)"
    echo "  [INFO] k6-compatible API! Easy migration to k6 later!"
    echo ""
    
    # Export environment variables for Node.js script
    export CONFIG_BUCKET
    export RESULTS_BUCKET
    export TEST_ID
    export RUN_ID
    export CONTAINER_ID
    export RESULTS_PREFIX
    
    # Set NODE_PATH so Node.js can find modules installed in /jmeter
    export NODE_PATH=/jmeter/node_modules
    
    # Run Node.js script with timeout (using TEST_TIMEOUT to leave time for uploads)
    timeout ${TEST_TIMEOUT} node "${TEST_FILE}" 2>&1
    JMETER_RAW_EXIT=$?
fi

echo ""

# CRITICAL: Disable exit-on-error NOW to ensure uploads always happen
# Even if test failed or subsequent commands fail, we MUST upload results
set +e

# Wait for Datadog forwarder to finish sending buffered metrics
if [ -n "$FORWARDER_PID" ]; then
    echo "=========================================="
    echo "[DATADOG] Waiting for forwarder to complete"
    echo "=========================================="
    echo "[DATADOG] Giving forwarder 15 seconds to send final metrics..."
    
    # Give forwarder time to send final batch
    sleep 15
    
    # Check if forwarder is still running
    if kill -0 $FORWARDER_PID 2>/dev/null; then
        echo "[DATADOG] Stopping forwarder (PID: ${FORWARDER_PID})..."
        kill -TERM $FORWARDER_PID 2>/dev/null || true
        
        # Wait up to 5 seconds for graceful shutdown
        wait_count=0
        while [ $wait_count -lt 5 ]; do
            if ! kill -0 $FORWARDER_PID 2>/dev/null; then
                echo " [DATADOG] Forwarder stopped gracefully"
                break
            fi
            sleep 1
            wait_count=$((wait_count + 1))
        done
        
        # Force kill if still running
        if kill -0 $FORWARDER_PID 2>/dev/null; then
            echo "[DATADOG] Force stopping forwarder..."
            kill -KILL $FORWARDER_PID 2>/dev/null || true
        fi
    else
        echo " [DATADOG] Forwarder already completed"
    fi
    echo ""
fi

# Check if timeout occurred (exit code 124 = timeout)
if [ $JMETER_RAW_EXIT -eq 124 ]; then
    echo "  [TIMEOUT] Test exceeded maximum runtime (${TASK_TIMEOUT}s = $(($TASK_TIMEOUT / 60))m)"
    echo "  [TIMEOUT] Estimated duration was ${ESTIMATED_DURATION}s, but test ran longer"
    echo "  [TIMEOUT] This may indicate:"
    echo "   - Test is hung or has an infinite loop"
    echo "   - Estimated duration was too short"
    echo "   - Server responses are slower than expected"
    echo ""
    echo "  [INFO] Partial results will still be uploaded if available"
fi

# Determine actual success by checking if results file was created
# JMeter may return non-zero for warnings/test failures, but if results exist, test ran successfully
RESULTS_FILE="/tmp/results-0.jtl"
if [ -f "$RESULTS_FILE" ] && [ -s "$RESULTS_FILE" ]; then
    # Results file exists and is not empty - TEST FRAMEWORK RAN SUCCESSFULLY
    if [ $JMETER_RAW_EXIT -eq 124 ]; then
        echo "  [TIMEOUT] JMeter was stopped due to timeout, but partial results exist"
        echo "  [INFO] Container will report SUCCESS (exit 0) - partial results uploaded"
        JMETER_EXIT_CODE=0  # Changed: Return 0 for partial results
    else
        # Check if test passed or failed by examining results
        echo " [COMPLETE] Test execution completed - results file created (${RESULTS_FILE})"
        if [ $JMETER_RAW_EXIT -ne 0 ]; then
            echo "  [TEST FAILED] JMeter reported exit code ${JMETER_RAW_EXIT} (test assertions failed)"
            echo "  [UPLOAD] Results will still be uploaded to S3 for analysis"
            echo "  [INFO] Container will report SUCCESS (exit 0) - test framework executed properly"
            echo "  [INFO] Analyze JTL results file in S3 for detailed failure information"
        else
            echo " [TEST PASSED] All test assertions passed successfully"
            echo "  [INFO] Results will be uploaded to S3"
        fi
        JMETER_EXIT_CODE=0  # Always 0 if results exist (test framework succeeded)
    fi
elif [ $JMETER_RAW_EXIT -eq 0 ]; then
    echo " [COMPLETE] Test execution completed with exit code 0"
    echo "  [INFO] Results will be uploaded to S3 (if any)"
    JMETER_EXIT_CODE=0
else
    # No results file and non-zero exit - FRAMEWORK failure
    echo " [FRAMEWORK ERROR] Test framework failed with exit code: ${JMETER_RAW_EXIT}"
    echo " [FRAMEWORK ERROR] No results file created - test did not execute properly"
    echo "  [UPLOAD] Any partial artifacts (screenshots, logs) will still be uploaded"
    JMETER_EXIT_CODE=$JMETER_RAW_EXIT
fi

echo ""
echo "=========================================="
echo "[UPLOAD] Uploading Results to S3"
echo "=========================================="
echo ""

# Upload all result files from /tmp to container-specific folder
# Structure: results/{run_id}/container-{container_id}/filename.jtl
uploaded_count=0
failed_count=0

# Debug: Check if screenshots directory exists and list files
echo "[DEBUG] Checking for screenshots..."
if [ -d "/tmp/screenshots" ]; then
    screenshot_count=$(find /tmp/screenshots -name "*.png" | wc -l)
    echo "   Found screenshots directory with ${screenshot_count} PNG files"
    if [ $screenshot_count -gt 0 ]; then
        echo "   Screenshot files:"
        find /tmp/screenshots -name "*.png" -exec ls -lh {} \;
    fi
else
    echo "    Screenshots directory not found: /tmp/screenshots"
fi
echo ""

# Upload all result files including screenshots
# Process screenshots first to ensure they're uploaded
if [ -d "/tmp/screenshots" ]; then
    echo "[UPLOAD] Processing screenshots from /tmp/screenshots..."
    # Use process substitution to avoid subshell (pipe would lose variable updates)
    while read -r screenshot_file; do
        if [ -f "$screenshot_file" ]; then
            filename=$(basename "$screenshot_file")
            s3_key="${RESULTS_PREFIX}/container-${CONTAINER_ID}/screenshots/${filename}"
            
            echo "  [SCREENSHOT] Uploading: ${filename}"
            if upload_results "$screenshot_file" "$s3_key"; then
                ((uploaded_count++))
                echo "     Uploaded to: s3://${RESULTS_BUCKET}/${s3_key}"
            else
                ((failed_count++))
                echo "     Failed to upload screenshot"
            fi
        fi
    done < <(find /tmp/screenshots -name "*.png")
    echo ""
fi

# CRITICAL FIX: Disable 'set -e' for upload section to ensure all files upload even if some commands fail
# Without this, a single failed ls or missing file pattern would exit the script before JTL upload!
set +e  # Disable exit-on-error for upload section

# Upload generated API tests first (if they exist)
if [ -d "/jmeter/generated-api-tests" ]; then
    echo "[UPLOAD] Processing generated API tests from /jmeter/generated-api-tests..."
    for api_file in /jmeter/generated-api-tests/*; do
        if [ -f "$api_file" ]; then
            filename=$(basename "$api_file")
            s3_key="${RESULTS_PREFIX}/container-${CONTAINER_ID}/generated-api-tests/${filename}"
            
            echo "  [API-TEST] Uploading: ${filename}"
            if upload_results "$api_file" "$s3_key"; then
                ((uploaded_count++))
                echo "     Uploaded to: s3://${RESULTS_BUCKET}/${s3_key}"
            else
                ((failed_count++))
                echo "     Failed to upload API test file"
            fi
        fi
    done
    echo ""
fi

# Upload other result files
echo "[UPLOAD] Processing other result files..."
echo "[DEBUG] Checking for files matching patterns..."
echo "[DEBUG] Files in /tmp:"
ls -lah /tmp/*.jtl /tmp/*.log 2>&1 | head -20

for file in /tmp/*.jtl /tmp/*.log /tmp/*.csv /tmp/*.xml /tmp/*.png /jmeter/results/*.png; do
    if [ -f "$file" ]; then
        filename=$(basename "$file")
        s3_key="${RESULTS_PREFIX}/container-${CONTAINER_ID}/${filename}"
        
        echo "  [UPLOAD] ${file}"
        if upload_results "$file" "$s3_key"; then
            ((uploaded_count++))
            echo "   [SUCCESS] Uploaded to: s3://${RESULTS_BUCKET}/${s3_key}"
        else
            ((failed_count++))
            echo "    [FAILED] Could not upload: ${file}"
        fi
    else
        echo "  [SKIP] File not found or not a regular file: ${file}"
    fi
done

echo ""
echo "[SUMMARY] Upload Summary:"
echo "   Uploaded: ${uploaded_count} files"
if [ $failed_count -gt 0 ]; then
    echo "    Failed: ${failed_count} files"
fi

# Re-enable exit-on-error now that uploads are complete
set -e

echo ""
echo "=========================================="
echo "[COMPLETE] Container Execution Complete"
echo "=========================================="
echo "Test ID: ${TEST_ID}"
echo "Container ID: ${CONTAINER_ID}"
echo "JMeter Exit Code: ${JMETER_EXIT_CODE}"
echo "Files Uploaded: ${uploaded_count}"
echo "=========================================="
echo ""

# Force cleanup of any remaining processes
echo "[CLEANUP] Terminating any remaining background processes..."
# Kill all java processes (JMeter) except this script
pkill -9 java 2>/dev/null || true
# Kill any other JMeter-related processes
pkill -9 jmeter 2>/dev/null || true
# Kill Xvfb
if [ -n "$XVFB_PID" ] && kill -0 $XVFB_PID 2>/dev/null; then
    echo "[CLEANUP] Stopping Xvfb (PID: ${XVFB_PID})..."
    kill $XVFB_PID 2>/dev/null || true
fi
echo " [CLEANUP] Cleanup complete"
echo ""

# Give a brief moment for cleanup
sleep 2

echo "[EXIT] Container will now terminate"
# Exit with JMeter's exit code
exit $JMETER_EXIT_CODE
