#!/bin/bash

# Deploy Healwright ML Backend (Cost-Optimized)
#
# This script deploys the cost-optimized Healwright ML infrastructure:
# - Lambda function for ML backend
# - DynamoDB tables (on-demand pricing)
# - API Gateway
# - Lambda warming function
#
# Estimated Monthly Cost: $10-15 (scales to ~$0 when idle)
#
# Usage:
#   ./scripts/deploy-healwright.sh [environment]
#
# Arguments:
#   environment - dev, staging, or prod (default: dev)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
ENV=${1:-dev}
STACK_NAME="${ENV}-healwright"

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Healwright ML Backend Deployment${NC}"
echo -e "${GREEN}(Cost-Optimized - DynamoDB)${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "Environment: ${YELLOW}${ENV}${NC}"
echo -e "Stack Name: ${YELLOW}${STACK_NAME}${NC}"
echo -e "Estimated Cost: ${BLUE}\$10-15/month${NC}"
echo ""

# Check prerequisites
echo -e "${YELLOW}Checking prerequisites...${NC}"

if ! command -v aws &> /dev/null; then
    echo -e "${RED}ERROR: AWS CLI is not installed${NC}"
    exit 1
fi

if ! command -v cdk &> /dev/null; then
    echo -e "${RED}ERROR: AWS CDK is not installed${NC}"
    echo "Install with: npm install -g aws-cdk"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo -e "${RED}ERROR: Node.js is not installed${NC}"
    exit 1
fi

echo -e "${GREEN}✓ All prerequisites met${NC}"
echo ""

# Navigate to IAC directory
cd "$(dirname "$0")/../iac"

# Install dependencies
echo -e "${YELLOW}Installing CDK dependencies...${NC}"
npm install
echo -e "${GREEN}✓ CDK dependencies installed${NC}"
echo ""

# Install Lambda dependencies
echo -e "${YELLOW}Installing Lambda function dependencies...${NC}"
cd lambda/healwright-ml
npm install
cd ../..
echo -e "${GREEN}✓ Lambda dependencies installed${NC}"
echo ""

# Bootstrap CDK (if needed)
echo -e "${YELLOW}Checking CDK bootstrap...${NC}"
if ! aws cloudformation describe-stacks --stack-name CDKToolkit &> /dev/null; then
    echo -e "${YELLOW}Bootstrapping CDK...${NC}"
    cdk bootstrap
    echo -e "${GREEN}✓ CDK bootstrapped${NC}"
else
    echo -e "${GREEN}✓ CDK already bootstrapped${NC}"
fi
echo ""

# Synthesize CloudFormation template
echo -e "${YELLOW}Synthesizing CloudFormation template...${NC}"
cdk synth ${STACK_NAME}
echo -e "${GREEN}✓ Template synthesized${NC}"
echo ""

# Deploy stack
echo -e "${YELLOW}Deploying Healwright ML stack...${NC}"
echo -e "${YELLOW}This should take 2-3 minutes...${NC}"
echo ""

cdk deploy ${STACK_NAME} --require-approval never

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}Deployment Successful!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    
    # Get stack outputs
    echo -e "${YELLOW}Stack Outputs:${NC}"
    aws cloudformation describe-stacks \
        --stack-name ${STACK_NAME} \
        --query 'Stacks[0].Outputs' \
        --output table
    
    echo ""
    echo -e "${GREEN}✨ Cost-Optimized Architecture Benefits:${NC}"
    echo -e "  ${BLUE}•${NC} No VPC charges"
    echo -e "  ${BLUE}•${NC} No Aurora database ($43/month saved!)"
    echo -e "  ${BLUE}•${NC} No RDS Proxy ($11/month saved!)"
    echo -e "  ${BLUE}•${NC} DynamoDB scales to near-$0 when idle"
    echo -e "  ${BLUE}•${NC} Lambda only charges per request"
    echo ""
    echo -e "${YELLOW}Estimated Monthly Cost: \$10-15${NC}"
    echo ""
    
    # Get API URL
    API_URL=$(aws cloudformation describe-stacks \
        --stack-name ${STACK_NAME} \
        --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' \
        --output text)
    
    echo -e "${YELLOW}Next Steps:${NC}"
    echo ""
    echo "1. Test the API:"
    echo -e "   ${GREEN}curl ${API_URL}../health${NC}"
    echo ""
    echo "2. Set environment variable in your Playwright tests:"
    echo -e "   ${GREEN}export HEALWRIGHT_ML_URL='${API_URL}'${NC}"
    echo ""
    echo "3. Update healwright.config.js:"
    echo -e "   ${GREEN}ml: { serverUrl: '${API_URL}' }${NC}"
    echo ""
    echo "4. Run your tests with hybrid mode:"
    echo -e "   ${GREEN}HEALWRIGHT_MODE=hybrid npm test${NC}"
    echo ""
    
else
    echo ""
    echo -e "${RED}========================================${NC}"
    echo -e "${RED}Deployment Failed!${NC}"
    echo -e "${RED}========================================${NC}"
    echo ""
    echo "Check the error messages above for details."
    exit 1
fi